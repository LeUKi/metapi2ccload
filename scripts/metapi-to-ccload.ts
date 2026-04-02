#!/usr/bin/env bun

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/**
 * 这个脚本用于把 metapi 备份转换成一个或多个 ccload CSV 导出文件。
 *
 * 核心思路：
 * 1. metapi 里的 `tokenRoute` 本身不是最终的 ccload 渠道。
 * 2. ccload 渠道要从展平后的上游通道组生成：
 *      site + account + token-or-fallback-secret
 * 3. 一个通道组可以根据用户选择的转换配置扇出成多条 ccload 记录：
 *      - 模型模式：merge 或 split
 *      - 渠道类型：一个或多个
 *
 * 扇出示例：
 * - 模型列表：gpt-5.4,gpt-5.3-codex
 * - 模型模式：split
 * - 渠道类型：codex,openai
 *
 * 如果某个通道组同时支持两个模型，则会变成四条记录：
 * - gpt-5.4 + codex
 * - gpt-5.4 + openai
 * - gpt-5.3-codex + codex
 * - gpt-5.3-codex + openai
 */

interface MetapiBackup {
  version: string;
  timestamp: number;
  accounts: MetapiAccounts;
  preferences: {
    settings: SettingItem[];
  };
}

interface MetapiAccounts {
  sites: Site[];
  accounts: Account[];
  accountTokens: AccountToken[];
  tokenRoutes: TokenRoute[];
  routeChannels: RouteChannel[];
  routeGroupSources: RouteGroupSource[];
  siteDisabledModels: SiteDisabledModel[];
  manualModels: unknown[];
  downstreamApiKeys: DownstreamApiKey[];
}

interface Site {
  id: number;
  name: string;
  url: string;
  externalCheckinUrl: string | null;
  platform: string;
  proxyUrl: string | null;
  useSystemProxy: boolean;
  customHeaders: string | null;
  status: string;
  isPinned: boolean;
  sortOrder: number;
  globalWeight: number;
  apiKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Account {
  id: number;
  siteId: number;
  username: string | null;
  accessToken: string;
  apiToken: string | null;
  balance: number;
  quota: number;
  unitCost: number | null;
  valueScore: number;
  status: string;
  isPinned: boolean;
  sortOrder: number;
  checkinEnabled: boolean;
  oauthProvider: string | null;
  oauthAccountKey: string | null;
  oauthProjectId: string | null;
  extraConfig: string;
  createdAt: string;
  updatedAt: string;
}

interface AccountToken {
  id: number;
  accountId: number;
  name: string;
  token: string;
  tokenGroup: string;
  valueStatus: string;
  source: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TokenRoute {
  id: number;
  modelPattern: string;
  displayName: string | null;
  displayIcon: string | null;
  routeMode: string;
  modelMapping: string | null;
  decisionSnapshot: string | null;
  decisionRefreshedAt: string | null;
  routingStrategy: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RouteChannel {
  id: number;
  routeId: number;
  accountId: number;
  tokenId: number | null;
  sourceModel: string | null;
  priority: number;
  weight: number;
  enabled: boolean;
  manualOverride: boolean;
}

interface RouteGroupSource {
  id: number;
  groupRouteId: number;
  sourceRouteId: number;
}

interface SiteDisabled模型 {
  siteId: number;
  modelName: string;
}

interface DownstreamApiKey {
  name: string;
  key: string;
  description: string | null;
  groupName: string | null;
  tags: string | null;
  enabled: boolean;
  expiresAt: string | null;
  maxCost: number | null;
  maxRequests: number | null;
  supportedModels: string;
  allowedRouteIds: string | null;
  siteWeightMultipliers: string | null;
}

interface SettingItem {
  key: string;
  value: unknown;
}

type ModelMode = 'merge' | 'split';
type OutputMode = 'single' | 'per-profile';

interface CliArgs {
  input?: string;
  output?: string;
  models?: string[];
  channelTypes?: string[];
  modelMode?: ModelMode;
  profileName?: string;
  appendProfileNameToName?: boolean;
  dedupeExactRows?: boolean;
  outputMode?: OutputMode;
  preview?: boolean;
  yes?: boolean;
}

interface ConversionProfile {
  name: string;
  models: string[];
  modelMode: ModelMode;
  channelTypes: string[];
}

interface RuntimeConfig {
  inputPath: string;
  outputPath: string;
  profiles: ConversionProfile[];
  appendProfileNameToName: boolean;
  dedupeExactRows: boolean;
  outputMode: OutputMode;
  previewOnly: boolean;
  autoConfirm: boolean;
}

interface IndexedMetapi {
  siteById: Map<number, Site>;
  accountById: Map<number, Account>;
  tokenById: Map<number, AccountToken>;
  routeById: Map<number, TokenRoute>;
  routeChannelsByRouteId: Map<number, RouteChannel[]>;
  groupSourceRouteIdsByGroupRouteId: Map<number, number[]>;
}

interface ModelResolution {
  model: string;
  logicalRouteIds: number[];
  concreteRouteIds: number[];
  suppressedStandaloneRouteIds: number[];
}

interface Channel通道组 {
  groupKey: string;
  site: Site;
  account: Account;
  token: AccountToken | null;
  apiKey: string;
  keySource: 'token' | 'apiToken' | 'accessToken' | 'missing';
  models: Set<string>;
  routeIds: Set<number>;
  routeModes: Set<string>;
  routingStrategies: Set<string>;
  modelMappings: string[];
  priorities: number[];
  weights: number[];
  routeChannelIds: number[];
  allRouteChannelsEnabled: boolean;
  hasSuspiciousPlatform: boolean;
}

interface CcloadRowDraft {
  name: string;
  api_key: string;
  url: string;
  priority: string;
  models: string;
  model_redirects: string;
  channel_type: string;
  key_strategy: string;
  enabled: string;
}

interface CcloadRow extends CcloadRowDraft {
  id: string;
}

interface ProfileConversionResult {
  profile: ConversionProfile;
  groups: ChannelGroup[];
  resolutions: ModelResolution[];
  warnings: string[];
  rowDrafts: CcloadRowDraft[];
}

interface PreparedOutput {
  outputPath: string;
  rows: CcloadRow[];
  profileName?: string;
}

const DEFAULT_MODELS = ['gpt-5.4', 'gpt-5.3-codex'];
const DEFAULT_CHANNEL_TYPES = ['codex', 'openai'];
const DEFAULT_MODEL_MODE: ModelMode = 'merge';
const DEFAULT_OUTPUT_MODE: OutputMode = 'single';
const SUSPICIOUS_PLATFORMS = new Set(['claude', 'anyrouter']);
const SAFE_PLATFORMS = new Set(['openai', 'new-api', 'sub2api']);
const CSV_HEADERS: Array<keyof CcloadRow> = [
  'id',
  'name',
  'api_key',
  'url',
  'priority',
  'models',
  'model_redirects',
  'channel_type',
  'key_strategy',
  'enabled',
];

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const inputPath = cliArgs.input ?? (await findLatestMetapiBackup(process.cwd()));

  if (!inputPath) {
    throw new Error(
      '当前目录未找到 metapi 备份文件，请通过 --input <file> 指定。',
    );
  }

  const backup = await loadMetapiBackup(inputPath);
  const config = await buildRuntimeConfig({
    cliArgs,
    backup,
    inputPath,
  });

  const indexed = buildIndexes(backup.accounts);
  const profileResults = config.profiles.map((profile) =>
    convertProfile({
      indexed,
      profile,
      appendProfileNameToName: config.appendProfileNameToName,
    }),
  );

  const preparedOutputs = prepareOutputs({
    baseOutputPath: config.outputPath,
    outputMode: config.outputMode,
    dedupeExactRows: config.dedupeExactRows,
    profileResults,
  });

  printConversionSummary({
    backup,
    config,
    profileResults,
    preparedOutputs,
  });

  if (config.previewOnly) {
    printPreviewRows(preparedOutputs);
    console.log('\n预览模式已启用，不会写入任何文件。');
    return;
  }

  if (!config.autoConfirm) {
    const approved = await confirmPrompt('继续并写入 CSV 文件吗？[y/N]: ');
    if (!approved) {
      console.log('已取消，不会写入任何文件。');
      return;
    }
  }

  for (const preparedOutput of preparedOutputs) {
    await writeFile(preparedOutput.outputPath, renderCsv(preparedOutput.rows), 'utf8');
  }

  console.log('\n处理完成，已写入：');
  for (const preparedOutput of preparedOutputs) {
    console.log(`- ${preparedOutput.outputPath}（${preparedOutput.rows.length} 行）`);
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case '--input':
      case '-i':
        args.input = expectValue(current, next);
        index += 1;
        break;
      case '--output':
      case '-o':
        args.output = expectValue(current, next);
        index += 1;
        break;
      case '--models':
      case '-m':
        args.models = splitCommaSeparated(expectValue(current, next));
        index += 1;
        break;
      case '--channel-types':
      case '-t':
        args.channelTypes = splitCommaSeparated(expectValue(current, next));
        index += 1;
        break;
      case '--model-mode':
        args.modelMode = parseModelMode(expectValue(current, next));
        index += 1;
        break;
      case '--profile-name':
        args.profileName = expectValue(current, next).trim();
        index += 1;
        break;
      case '--append-profile-name':
        args.appendProfileNameToName = true;
        break;
      case '--dedupe':
        args.dedupeExactRows = true;
        break;
      case '--output-mode':
        args.outputMode = parseOutputMode(expectValue(current, next));
        index += 1;
        break;
      case '--preview':
        args.preview = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--help':
      case '-h':
        printHelpAndExit();
        break;
      default:
        throw new Error(`未知参数：${current}`);
    }
  }

  return args;
}

function expectValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`参数 ${flag} 缺少取值`);
  }

  return value;
}

function printHelpAndExit(): never {
  console.log(`
用法：
  bun scripts/metapi-to-ccload.ts [参数]

参数：
  -i, --input <file>           metapi 备份 JSON 路径
  -o, --output <file>          输出 ccload CSV 路径或基础路径
  -m, --models <list>          单个 profile 的模型列表，使用逗号分隔
  -t, --channel-types <list>   单个 profile 的 ccload channel_type 列表，使用逗号分隔
      --model-mode <mode>      merge | split
      --profile-name <name>    单 profile CLI 模式下可选的 profile 名称
      --append-profile-name    把 profile 名追加到渠道名称中
      --dedupe                 在当前输出范围内去除完全重复的行
      --output-mode <mode>     single | per-profile
      --preview                仅预览，不写入 CSV 文件
  -y, --yes                    跳过最终确认
  -h, --help                   显示帮助

示例：
  bun scripts/metapi-to-ccload.ts
  bun scripts/metapi-to-ccload.ts -m gpt-5.4,gpt-5.3-codex -t codex,openai --model-mode split
  bun scripts/metapi-to-ccload.ts --output-mode per-profile --append-profile-name
  bun scripts/metapi-to-ccload.ts --preview
`);
  process.exit(0);
}

function parseModelMode(value: string): ModelMode {
  if (value === 'merge' || value === 'split') {
    return value;
  }

  throw new Error(`无效的模型模式：${value}。期望值为 merge 或 split。`);
}

function parseOutputMode(value: string): OutputMode {
  if (value === 'single' || value === 'per-profile') {
    return value;
  }

  throw new Error(`无效的输出模式：${value}。期望值为 single 或 per-profile。`);
}

async function findLatestMetapiBackup(cwd: string): Promise<string | undefined> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^metapi-backup-.*\.json$/i.test(entry.name))
    .map((entry) => path.join(cwd, entry.name))
    .sort();

  return candidates.at(-1);
}

async function loadMetapiBackup(inputPath: string): Promise<MetapiBackup> {
  const rawText = await readFile(inputPath, 'utf8');
  const parsed = JSON.parse(rawText) as MetapiBackup;

  if (!parsed.accounts?.sites || !parsed.accounts?.tokenRoutes || !parsed.accounts?.routeChannels) {
    throw new Error(`文件看起来不是合法的 metapi 备份：${inputPath}`);
  }

  return parsed;
}

async function buildRuntimeConfig(params: {
  cliArgs: CliArgs;
  backup: MetapiBackup;
  inputPath: string;
}): Promise<RuntimeConfig> {
  const { cliArgs, inputPath } = params;

  // 完整指定参数的单 profile CLI 模式仍然保留，方便自动化调用。
  // 如果调用方传入了旧式模型/渠道参数，就把它视为一个
  // 单 profile 导出任务，并跳过交互式 profile 配置流程。
  if (cliArgs.models && cliArgs.channelTypes) {
    const profile: ConversionProfile = {
      name:
        cliArgs.profileName ||
        buildDefaultProfileName({
          index: 1,
          models: cliArgs.models,
          modelMode: cliArgs.modelMode ?? DEFAULT_MODEL_MODE,
          channelTypes: cliArgs.channelTypes,
        }),
      models: cliArgs.models,
      modelMode: cliArgs.modelMode ?? DEFAULT_MODEL_MODE,
      channelTypes: cliArgs.channelTypes,
    };

    return {
      inputPath,
      outputPath: cliArgs.output ?? buildDefaultOutputPath(inputPath),
      profiles: [profile],
      appendProfileNameToName: Boolean(cliArgs.appendProfileNameToName),
      dedupeExactRows: Boolean(cliArgs.dedupeExactRows),
      outputMode: cliArgs.outputMode ?? DEFAULT_OUTPUT_MODE,
      previewOnly: Boolean(cliArgs.preview),
      autoConfirm: Boolean(cliArgs.yes),
    };
  }

  const prompt = createInterface({ input, output });

  try {
    console.log(`检测到 metapi 备份：${inputPath}`);
    console.log(`数据快照时间：${new Date(params.backup.timestamp).toISOString()}`);
    console.log(
      `备份规模：sites=${params.backup.accounts.sites.length}，accounts=${params.backup.accounts.accounts.length}，tokens=${params.backup.accounts.accountTokens.length}，routes=${params.backup.accounts.tokenRoutes.length}，routeChannels=${params.backup.accounts.routeChannels.length}`,
    );

    // 用户希望这是一个可复用的转换器，能够在一次运行中表达多种
    // 导出场景，因此这里先询问要配置多少个转换 profile。
    //
    const profileCount = await askPositiveInteger({
      prompt,
      message: '要配置多少个转换 profile？[1]: ',
      defaultValue: 1,
    });

    const profiles: ConversionProfile[] = [];

    for (let index = 0; index < profileCount; index += 1) {
      const previousProfile = profiles.at(-1);
      const defaultModels = previousProfile?.models ?? DEFAULT_MODELS;
      const defaultModelMode = previousProfile?.modelMode ?? DEFAULT_MODEL_MODE;
      const defaultChannelTypes = previousProfile?.channelTypes ?? DEFAULT_CHANNEL_TYPES;
      const defaultName = buildDefaultProfileName({
        index: index + 1,
        models: defaultModels,
        modelMode: defaultModelMode,
        channelTypes: defaultChannelTypes,
      });

      console.log(`\nProfile ${index + 1}`);
      const name =
        (await prompt.question(`Profile 名称 [${defaultName}]: `)).trim() || defaultName;
      const models = splitCommaSeparated(
        await prompt.question(`模型列表（逗号分隔）[${defaultModels.join(',')}]: `),
        defaultModels,
      );
      const modelMode = await askChoice<ModelMode>({
        prompt,
        message: `模型模式（merge/split）[${defaultModelMode}]: `,
        defaultValue: defaultModelMode,
        choices: ['merge', 'split'],
      });
      const channelTypes = splitCommaSeparated(
        await prompt.question(
          `ccload channel_type 列表（逗号分隔）[${defaultChannelTypes.join(',')}]: `,
        ),
        defaultChannelTypes,
      );

      profiles.push({
        name,
        models,
        modelMode,
        channelTypes,
      });
    }

    const outputMode = await askChoice<OutputMode>({
      prompt,
      message: `输出模式（single/per-profile）[${DEFAULT_OUTPUT_MODE}]: `,
      defaultValue: cliArgs.outputMode ?? DEFAULT_OUTPUT_MODE,
      choices: ['single', 'per-profile'],
    });
    const dedupeExactRows = await askBoolean({
      prompt,
      message: '是否在当前输出范围内去除完全重复的行？[y/N]: ',
      defaultValue: Boolean(cliArgs.dedupeExactRows),
    });
    const appendProfileNameToName = await askBoolean({
      prompt,
      message: '是否把 profile 名追加到渠道名称里？[y/N]: ',
      defaultValue: Boolean(cliArgs.appendProfileNameToName),
    });
    const previewOnly = await askBoolean({
      prompt,
      message: '是否仅预览而不写入 CSV 文件？[y/N]: ',
      defaultValue: Boolean(cliArgs.preview),
    });

    const defaultOutputPath = cliArgs.output ?? buildDefaultOutputPath(inputPath);
    const outputPath =
      (await prompt.question(`输出 CSV 路径或基础路径 [${defaultOutputPath}]: `)).trim() ||
      defaultOutputPath;

    return {
      inputPath,
      outputPath,
      profiles,
      appendProfileNameToName,
      dedupeExactRows,
      outputMode,
      previewOnly,
      autoConfirm: Boolean(cliArgs.yes),
    };
  } finally {
    prompt.close();
  }
}

function buildDefaultOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}.ccload.csv`);
}

function buildDefaultProfileName(params: {
  index: number;
  models: string[];
  modelMode: ModelMode;
  channelTypes: string[];
}): string {
  const modelPart = slugify(params.models.join('-')) || `profile-${params.index}`;
  const typePart = slugify(params.channelTypes.join('-')) || 'types';
  return `${modelPart}-${params.modelMode}-${typePart}`;
}

function splitCommaSeparated(raw: string, fallback: string[] = []): string[] {
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return values.length > 0 ? Array.from(new Set(values)) : [...fallback];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildIndexes(accounts: MetapiAccounts): IndexedMetapi {
  // 预先建立这些索引可以让转换逻辑更清晰，主流程不需要反复扫描数组。
  // 导出阶段只需做索引查找，而不是重复遍历 sites/accounts/tokens/routes。
  const siteById = new Map(accounts.sites.map((site) => [site.id, site]));
  const accountById = new Map(accounts.accounts.map((account) => [account.id, account]));
  const tokenById = new Map(accounts.accountTokens.map((token) => [token.id, token]));
  const routeById = new Map(accounts.tokenRoutes.map((route) => [route.id, route]));

  const routeChannelsByRouteId = new Map<number, RouteChannel[]>();
  for (const routeChannel of accounts.routeChannels) {
    const bucket = routeChannelsByRouteId.get(routeChannel.routeId) ?? [];
    bucket.push(routeChannel);
    routeChannelsByRouteId.set(routeChannel.routeId, bucket);
  }

  const groupSourceRouteIdsByGroupRouteId = new Map<number, number[]>();
  for (const link of accounts.routeGroupSources) {
    const bucket = groupSourceRouteIdsByGroupRouteId.get(link.groupRouteId) ?? [];
    bucket.push(link.sourceRouteId);
    groupSourceRouteIdsByGroupRouteId.set(link.groupRouteId, bucket);
  }

  return {
    siteById,
    accountById,
    tokenById,
    routeById,
    routeChannelsByRouteId,
    groupSourceRouteIdsByGroupRouteId,
  };
}

function convertProfile(params: {
  indexed: IndexedMetapi;
  profile: ConversionProfile;
  appendProfileNameToName: boolean;
}): ProfileConversionResult {
  const { indexed, profile, appendProfileNameToName } = params;
  const warnings: string[] = [];

  const resolutions = profile.models.map((model) =>
    resolveRoutesForModel({
      model,
      indexed,
    }),
  );

  const groupByKey = new Map<string, ChannelGroup>();

  // 单个 profile 的转换策略：
  // 1. 把 profile 请求的模型解析为 concrete route ID。
  // 2. 读取这些 route 挂载的全部 routeChannels。
  // 3. 按 site/account/token 折叠成逻辑通道组。
  // 4. 再根据 profile 的 merge/split 模式
  //    和 channel_type 列表，把每个通道组扇出成最终记录。
  for (const resolution of resolutions) {
    if (resolution.concreteRouteIds.length === 0) {
      warnings.push(`模型 ${resolution.model} 没有匹配到任何可落地的 concrete route。`);
      continue;
    }

    for (const routeId of resolution.concreteRouteIds) {
      const route = indexed.routeById.get(routeId);
      if (!route) {
        warnings.push(`已解析的 route ${routeId} 对于模型 ${resolution.model} 不存在。`);
        continue;
      }

      const routeChannels = indexed.routeChannelsByRouteId.get(routeId) ?? [];
      if (routeChannels.length === 0) {
        warnings.push(
          `Concrete route ${routeId} (${route.modelPattern}) 没有 routeChannels，因此无法生成 ccload 行。`,
        );
      }

      for (const routeChannel of routeChannels) {
        const account = indexed.accountById.get(routeChannel.accountId);
        if (!account) {
          warnings.push(`routeChannel ${routeChannel.id} 引用了不存在的 account ${routeChannel.accountId}.`);
          continue;
        }

        const site = indexed.siteById.get(account.siteId);
        if (!site) {
          warnings.push(`account ${account.id} 引用了不存在的 site ${account.siteId}.`);
          continue;
        }

        const token = routeChannel.tokenId === null ? null : indexed.tokenById.get(routeChannel.tokenId) ?? null;
        const apiKey = chooseApiKey(account, token);
        const groupKey = buildGroupKey(site, account, token);
        const group = groupByKey.get(groupKey) ?? createEmptyGroup({ site, account, token, apiKey });

        group.models.add(resolution.model);
        group.routeIds.add(route.id);
        group.routeModes.add(route.routeMode);
        group.routingStrategies.add(route.routingStrategy);
        group.priorities.push(routeChannel.priority);
        group.weights.push(routeChannel.weight);
        group.routeChannelIds.push(routeChannel.id);
        group.allRouteChannelsEnabled = group.allRouteChannelsEnabled && routeChannel.enabled;
        group.hasSuspiciousPlatform = group.hasSuspiciousPlatform || SUSPICIOUS_PLATFORMS.has(site.platform);

        if (route.modelMapping) {
          group.modelMappings.push(route.modelMapping);
        }

        groupByKey.set(groupKey, group);
      }
    }
  }

  const groups = Array.from(groupByKey.values()).sort(compareGroups);
  for (const group of groups) {
    if (group.keySource === 'missing') {
      warnings.push(`通道组 ${group.groupKey} 没有可用的 token/api key。`);
    } else if (group.keySource === 'accessToken') {
      warnings.push(
        `通道组 ${group.groupKey} 回退使用了 accessToken。请确认该密钥可作为 ccload api_key 使用。`,
      );
    }

    if (group.hasSuspiciousPlatform) {
      warnings.push(
        `通道组 ${group.groupKey} 使用的平台是 ${group.site.platform}。把它转换成 ccload 渠道类型属于激进策略，建议手动核实。`,
      );
    }
  }

  const rowDrafts = buildRowDrafts({
    groups,
    profile,
    appendProfileNameToName,
  });

  return {
    profile,
    groups,
    resolutions,
    warnings: Array.from(new Set(warnings)).sort(),
    rowDrafts,
  };
}

function resolveRoutesForModel(params: {
  model: string;
  indexed: IndexedMetapi;
}): ModelResolution {
  const { model, indexed } = params;
  const matchedRoutes = Array.from(indexed.routeById.values()).filter(
    (route) => route.modelPattern === model,
  );

  // 通用的 group 处理规则：
  // - 如果某模型存在 `explicit_group` route，则把该 group route 视为逻辑路由。
  // - 摘要里显示的是逻辑路由，而不是它展开后的每一条 source route。
  // - 如果 group 的 source route 也有相同的 modelPattern，则把它从独立逻辑路由中压掉，
  //   避免重复统计。
  // - 然后再把逻辑路由递归展开成 concrete route，
  //   直到拿到真正拥有 routeChannels 的 route。
  const groupRouteIds = matchedRoutes
    .filter((route) => route.routeMode === 'explicit_group')
    .map((route) => route.id);
  const suppressedStandaloneRouteIds = new Set<number>();

  for (const groupRouteId of groupRouteIds) {
    for (const sourceRouteId of indexed.groupSourceRouteIdsByGroupRouteId.get(groupRouteId) ?? []) {
      const sourceRoute = indexed.routeById.get(sourceRouteId);
      if (sourceRoute?.modelPattern === model) {
        suppressedStandaloneRouteIds.add(sourceRouteId);
      }
    }
  }

  const logicalRouteIds = matchedRoutes
    .map((route) => route.id)
    .filter((routeId) => !suppressedStandaloneRouteIds.has(routeId));

  const concreteRouteIds = Array.from(
    new Set(
      logicalRouteIds.flatMap((routeId) =>
        expandToConcreteRouteIds({
          routeId,
          indexed,
          visited: new Set<number>(),
        }),
      ),
    ),
  ).sort((left, right) => left - right);

  return {
    model,
    logicalRouteIds: logicalRouteIds.sort((left, right) => left - right),
    concreteRouteIds,
    suppressedStandaloneRouteIds: Array.from(suppressedStandaloneRouteIds).sort(
      (left, right) => left - right,
    ),
  };
}

function expandToConcreteRouteIds(params: {
  routeId: number;
  indexed: IndexedMetapi;
  visited: Set<number>;
}): number[] {
  const { routeId, indexed, visited } = params;
  const route = indexed.routeById.get(routeId);
  if (!route) {
    return [];
  }

  if (visited.has(routeId)) {
    throw new Error(`在展开 route group 时检测到循环，route 为 ${routeId}.`);
  }

  if (route.routeMode !== 'explicit_group') {
    return [routeId];
  }

  // group route 只是容器，因此这里递归走向它的 source routes，直到
  // 走到真正能够产出 routeChannels 的 concrete route。
  visited.add(routeId);

  const sourceRouteIds = indexed.groupSourceRouteIdsByGroupRouteId.get(routeId) ?? [];
  const expanded = sourceRouteIds.flatMap((sourceRouteId) =>
    expandToConcreteRouteIds({
      routeId: sourceRouteId,
      indexed,
      visited,
    }),
  );

  visited.delete(routeId);
  return expanded;
}

function chooseApiKey(
  account: Account,
  token: AccountToken | null,
): { value: string; source: ChannelGroup['keySource'] } {
  if (token?.token) {
    return { value: token.token, source: 'token' };
  }

  if (account.apiToken) {
    return { value: account.apiToken, source: 'apiToken' };
  }

  // accessToken 只作为最后兜底方案保留，因为有些 metapi 平台
  // 可能没有单独暴露 API token；即便如此，脚本仍会对这种回退发出警告。
  if (account.accessToken) {
    return { value: account.accessToken, source: 'accessToken' };
  }

  return { value: '', source: 'missing' };
}

function buildGroupKey(site: Site, account: Account, token: AccountToken | null): string {
  const tokenPart = token ? `token:${token.id}` : 'token:fallback-account-secret';
  return `${site.url} | account:${account.id} | ${tokenPart}`;
}

function createEmptyGroup(params: {
  site: Site;
  account: Account;
  token: AccountToken | null;
  apiKey: { value: string; source: ChannelGroup['keySource'] };
}): Channel通道组 {
  return {
    groupKey: buildGroupKey(params.site, params.account, params.token),
    site: params.site,
    account: params.account,
    token: params.token,
    apiKey: params.apiKey.value,
    keySource: params.apiKey.source,
    models: new Set<string>(),
    routeIds: new Set<number>(),
    routeModes: new Set<string>(),
    routingStrategies: new Set<string>(),
    modelMappings: [],
    priorities: [],
    weights: [],
    routeChannelIds: [],
    allRouteChannelsEnabled: true,
    hasSuspiciousPlatform: SUSPICIOUS_PLATFORMS.has(params.site.platform),
  };
}

function compareGroups(left: ChannelGroup, right: ChannelGroup): number {
  return (
    left.site.url.localeCompare(right.site.url) ||
    left.account.id - right.account.id ||
    (left.token?.id ?? -1) - (right.token?.id ?? -1)
  );
}

function buildRowDrafts(params: {
  groups: ChannelGroup[];
  profile: ConversionProfile;
  appendProfileNameToName: boolean;
}): CcloadRowDraft[] {
  const { groups, profile, appendProfileNameToName } = params;
  const rows: CcloadRowDraft[] = [];

  for (const group of groups) {
    // profile 决定了命中的模型是保留为一条合并记录，
    // 还是先拆成单模型记录，再进行 channel_type 扇出。
    const modelLabels = buildModelLabels({
      group,
      profile,
    });
    const minimumPriority = group.priorities.length > 0 ? Math.min(...group.priorities) : 0;
    const mergedModelRedirects = mergeModelRedirects(group.modelMappings);
    const enabled = isGroupEnabled(group);

    for (const modelLabel of modelLabels) {
      for (const channelType of profile.channelTypes) {
        rows.push({
          name: buildChannelName({
            group,
            modelLabel,
            channelType,
            profileName: profile.name,
            appendProfileNameToName,
          }),
          api_key: group.apiKey,
          url: group.site.url,
          priority: String(minimumPriority),
          models: modelLabel,
          model_redirects: JSON.stringify(mergedModelRedirects),
          channel_type: channelType,
          key_strategy: 'sequential',
          enabled: String(enabled),
        });
      }
    }
  }

  return rows;
}

function buildModelLabels(params: {
  group: ChannelGroup;
  profile: ConversionProfile;
}): string[] {
  const orderedModels = params.profile.models.filter((model) => params.group.models.has(model));

  if (params.profile.modelMode === 'split') {
    return orderedModels;
  }

  return orderedModels.length > 0 ? [orderedModels.join(',')] : [];
}

function mergeModelRedirects(modelMappings: string[]): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const mappingText of modelMappings) {
    try {
      const parsed = JSON.parse(mappingText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') {
            merged[key] = value;
          }
        }
      }
    } catch {
      // mapping 格式错误不应该导致整个导出失败，因此这里继续执行，
      // 只是在合并后的 redirect 对象里忽略这条非法 mapping。
    }
  }

  return merged;
}

function isGroupEnabled(group: ChannelGroup): boolean {
  // enabled 规则故意设置得比较严格，避免导出 metapi 已经判定有问题的
  // ccload 渠道。
  const accountActive = group.account.status === 'active';
  const siteActive = group.site.status === 'active';
  const tokenEnabled = group.token ? group.token.enabled : true;

  return (
    group.allRouteChannelsEnabled &&
    accountActive &&
    siteActive &&
    tokenEnabled &&
    group.apiKey.length > 0
  );
}

function buildChannelName(params: {
  group: ChannelGroup;
  modelLabel: string;
  channelType: string;
  profileName: string;
  appendProfileNameToName: boolean;
}): string {
  const { group, modelLabel, channelType, profileName, appendProfileNameToName } = params;

  // 用户要求的名称格式：
  //   site.url|label|acct-<id>|account-secret|models|channel_type
  // 可选尾段：
  //   |profile-name
  const parts = [
    group.site.url,
    buildDisplayLabel(group),
    `acct-${group.account.id}`,
    'account-secret',
    modelLabel,
    channelType,
  ];

  if (appendProfileNameToName) {
    parts.push(profileName);
  }

  return parts.join('|');
}

function buildDisplayLabel(group: ChannelGroup): string {
  // 第二段既要稳定，也要尽量可读。token 名通常是最合适的显示标签，
  // 因为它往往已经携带了用户自己的业务语义，
  // 比如 `metapi`、`default`、`user group (auto)`。
  if (group.token?.name?.trim()) {
    return group.token.name.trim();
  }

  if (group.account.username?.trim()) {
    return group.account.username.trim();
  }

  if (group.site.name?.trim() && group.site.name.trim() !== group.site.url) {
    return group.site.name.trim();
  }

  return 'account';
}

function prepareOutputs(params: {
  baseOutputPath: string;
  outputMode: OutputMode;
  dedupeExactRows: boolean;
  profileResults: ProfileConversionResult[];
}): PreparedOutput[] {
  const { baseOutputPath, outputMode, dedupeExactRows, profileResults } = params;

  if (outputMode === 'per-profile') {
    return profileResults.map((profileResult) => {
      const rowDrafts = dedupeExactRows
        ? dedupeRowDrafts(profileResult.rowDrafts)
        : profileResult.rowDrafts;

      return {
        outputPath: buildPerProfileOutputPath(baseOutputPath, profileResult.profile.name),
        rows: finalizeRows(rowDrafts),
        profileName: profileResult.profile.name,
      };
    });
  }

  const mergedDrafts = profileResults.flatMap((profileResult) => profileResult.rowDrafts);
  const finalDrafts = dedupeExactRows ? dedupeRowDrafts(mergedDrafts) : mergedDrafts;

  return [
    {
      outputPath: baseOutputPath,
      rows: finalizeRows(finalDrafts),
    },
  ];
}

function buildPerProfileOutputPath(baseOutputPath: string, profileName: string): string {
  const dir = path.dirname(baseOutputPath);
  const ext = path.extname(baseOutputPath) || '.csv';
  const base = path.basename(baseOutputPath, ext);
  return path.join(dir, `${base}.${slugify(profileName) || 'profile'}.csv`);
}

function dedupeRowDrafts(rowDrafts: CcloadRowDraft[]): CcloadRowDraft[] {
  const seen = new Set<string>();
  const deduped: CcloadRowDraft[] = [];

  for (const rowDraft of rowDrafts) {
    // ID 会在去重后重新分配，因此“完全相同行”的比较只看真实的
    // CSV 载荷字段。
    const key = JSON.stringify(rowDraft);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(rowDraft);
  }

  return deduped;
}

function finalizeRows(rowDrafts: CcloadRowDraft[]): CcloadRow[] {
  return rowDrafts.map((rowDraft, index) => ({
    id: String(index + 1),
    ...rowDraft,
  }));
}

function renderCsv(rows: CcloadRow[]): string {
  const lines = [CSV_HEADERS.join(',')];

  for (const row of rows) {
    lines.push(CSV_HEADERS.map((header) => csvEscape(row[header])).join(','));
  }

  // 继续保留 BOM，因为当前工作区里的 ccload CSV 已经使用了
  // UTF-8 BOM，这样通常更容易被表格工具正确打开。
  return `\uFEFF${lines.join('\n')}\n`;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

function printConversionSummary(params: {
  backup: MetapiBackup;
  config: RuntimeConfig;
  profileResults: ProfileConversionResult[];
  preparedOutputs: PreparedOutput[];
}): void {
  const { backup, config, profileResults, preparedOutputs } = params;

  console.log('\n转换摘要');
  console.log(`- 输入文件：${config.inputPath}`);
  console.log(`- 输出模式：${config.outputMode}`);
  console.log(`- 基础输出路径：${config.outputPath}`);
  console.log(`- 是否去重完全重复行：${config.dedupeExactRows}`);
  console.log(`- 是否在渠道名后追加 profile 名：${config.appendProfileNameToName}`);
  console.log(`- 是否仅预览：${config.previewOnly}`);
  console.log(`- 备份版本：${backup.version}`);
  console.log(`- profile 数量：${config.profiles.length}`);

  for (const profileResult of profileResults) {
    const enabledGroupCount = profileResult.groups.filter(isGroupEnabled).length;
    const safePlatformGroupCount = profileResult.groups.filter((group) =>
      SAFE_PLATFORMS.has(group.site.platform),
    ).length;
    const platformCounts = countBy(profileResult.groups.map((group) => group.site.platform));
    const keySourceCounts = countBy(profileResult.groups.map((group) => group.keySource));

    console.log(`\nProfile：${profileResult.profile.name}`);
    console.log(`- 模型列表：${profileResult.profile.models.join(', ')}`);
    console.log(`- 模型模式：${profileResult.profile.modelMode}`);
    console.log(`- 渠道类型：${profileResult.profile.channelTypes.join(', ')}`);
    console.log(`- 逻辑通道组数量：${profileResult.groups.length}`);
    console.log(`- 启用中的通道组数量：${enabledGroupCount}`);
    console.log(`- openai/new-api/sub2api 平台上的通道组数量：${safePlatformGroupCount}`);
    console.log(`- 输出级去重前的行数：${profileResult.rowDrafts.length}`);
    console.log(`- 平台分布：${formatCounts(platformCounts)}`);
    console.log(`- api key 来源分布：${formatCounts(keySourceCounts)}`);

    console.log('- 模型路由解析：');
    for (const resolution of profileResult.resolutions) {
      console.log(
        `  - ${resolution.model}: logicalRoutes=[${resolution.logicalRouteIds.join(', ')}], concreteRoutes=[${resolution.concreteRouteIds.join(', ')}], suppressedStandalone=[${resolution.suppressedStandaloneRouteIds.join(', ')}]`,
      );
    }

    if (profileResult.warnings.length > 0) {
      console.log('- 警告：');
      for (const warning of profileResult.warnings) {
        console.log(`  - ${warning}`);
      }
    }
  }

  console.log('\n计划输出的文件');
  for (const preparedOutput of preparedOutputs) {
    const profileSuffix = preparedOutput.profileName ? ` [profile=${preparedOutput.profileName}]` : '';
    console.log(`- ${preparedOutput.outputPath} -> ${preparedOutput.rows.length} 行${profileSuffix}`);
  }
}

function printPreviewRows(preparedOutputs: PreparedOutput[]): void {
  console.log('\n预览行');

  for (const preparedOutput of preparedOutputs) {
    const profileSuffix = preparedOutput.profileName
      ? ` [profile=${preparedOutput.profileName}]`
      : '';
    console.log(`- ${preparedOutput.outputPath}${profileSuffix}`);

    const previewRows = preparedOutput.rows.slice(0, 5);
    if (previewRows.length === 0) {
      console.log('  （没有行）');
      continue;
    }

    for (const row of previewRows) {
      console.log(
        `  - ${row.id} | ${row.name} | 渠道类型=${row.channel_type} | 启用=${row.enabled} | 模型=${row.models}`,
      );
    }

    if (preparedOutput.rows.length > previewRows.length) {
      console.log(`  - ... 剩余 ${preparedOutput.rows.length - previewRows.length} 行`);
    }
  }
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

async function askPositiveInteger(params: {
  prompt: ReturnType<typeof createInterface>;
  message: string;
  defaultValue: number;
}): Promise<number> {
  while (true) {
    const answer = (await params.prompt.question(params.message)).trim();
    if (!answer) {
      return params.defaultValue;
    }

    const parsed = Number.parseInt(answer, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    console.log('请输入正整数。');
  }
}

async function askChoice<T extends string>(params: {
  prompt: ReturnType<typeof createInterface>;
  message: string;
  defaultValue: T;
  choices: T[];
}): Promise<T> {
  while (true) {
    const answer = (await params.prompt.question(params.message)).trim();
    if (!answer) {
      return params.defaultValue;
    }

    if (params.choices.includes(answer as T)) {
      return answer as T;
    }

    console.log(`请输入以下值之一：${params.choices.join(', ')}`);
  }
}

async function askBoolean(params: {
  prompt: ReturnType<typeof createInterface>;
  message: string;
  defaultValue: boolean;
}): Promise<boolean> {
  while (true) {
    const answer = (await params.prompt.question(params.message)).trim().toLowerCase();
    if (!answer) {
      return params.defaultValue;
    }

    if (answer === 'y' || answer === 'yes') {
      return true;
    }

    if (answer === 'n' || answer === 'no') {
      return false;
    }

    console.log('请输入 y/yes 或 n/no。');
  }
}

async function confirmPrompt(message: string): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question(message)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`错误：${message}`);
  process.exit(1);
});
