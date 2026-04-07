import { describe, expect, test } from 'bun:test';

import {
  buildBucketsForTest,
  buildRowDraftsForTest,
  collectExplicitGroupLogicalModelsForTest,
  normalizeProfileModesForTest,
  buildOutputBucketsForTest,
} from './metapi-to-ccload';

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    entryKey: 'entry-1',
    site: { id: 1, url: 'https://example.com', platform: 'openai', status: 'active', name: 'site' },
    account: { id: 10, siteId: 1, status: 'active', username: 'acct', accessToken: 'acc', apiToken: 'api' },
    token: { id: 100, name: 'metapi', token: 'tok', enabled: true },
    apiKey: 'tok',
    keySource: 'token',
    requestedModel: 'gpt-5.4',
    logicalRouteId: 1000,
    logicalModel: 'gpt-5.4',
    concreteRouteId: 1001,
    concreteModel: 'gpt-5.4',
    routeChannelId: 2001,
    rawSourceModel: 'gpt-5.4',
    canonicalModel: 'gpt-5.4',
    inferredCanonicalModel: 'gpt-5.4',
    canonicalModels: new Set(['gpt-5.4']),
    aliasModels: new Set(['gpt-5.4']),
    bundleIds: new Set<string>(),
    modelMappings: [],
    priority: 1,
    weight: 1,
    routeChannelEnabled: true,
    hasSuspiciousPlatform: false,
    ...overrides,
  };
}

describe('normalizeProfileModes', () => {
  test('legacy merge stays strict-source + merge + strict', () => {
    expect(normalizeProfileModesForTest({ modelMode: 'merge' })).toEqual({
      entryMode: 'strict-source',
      modelPackMode: 'merge',
      compatPolicy: 'strict',
    });
  });

  test('legacy split stays strict-source + split + strict', () => {
    expect(normalizeProfileModesForTest({ modelMode: 'split' })).toEqual({
      entryMode: 'strict-source',
      modelPackMode: 'split',
      compatPolicy: 'strict',
    });
  });

  test('metapi-inferred policy is accepted directly', () => {
    expect(normalizeProfileModesForTest({ compatPolicy: 'metapi-inferred' })).toEqual({
      entryMode: 'strict-source',
      modelPackMode: 'merge',
      compatPolicy: 'metapi-inferred',
    });
  });
});

describe('explicit group selection', () => {
  test('collects unique sorted logical models from explicit_group routes only', () => {
    expect(
      collectExplicitGroupLogicalModelsForTest([
        { id: 1, routeMode: 'explicit_group', modelPattern: 'glm-5' },
        { id: 2, routeMode: 'standard', modelPattern: 'gpt-5.4' },
        { id: 3, routeMode: 'explicit_group', modelPattern: 'deepseek-v3.2' },
        { id: 4, routeMode: 'explicit_group', modelPattern: 'glm-5' },
      ] as never),
    ).toEqual(['deepseek-v3.2', 'glm-5']);
  });
});

describe('bucket aggregation', () => {
  test('GLM-5 and glm-5 do not merge by default even under shared credential', () => {
    const entries = [
      makeEntry({
        entryKey: 'glm-upper',
        requestedModel: 'GLM-5',
        logicalModel: 'GLM-5',
        concreteModel: 'GLM-5',
        rawSourceModel: 'GLM-5',
        canonicalModel: 'GLM-5',
        canonicalModels: new Set(['GLM-5']),
        aliasModels: new Set(['GLM-5']),
      }),
      makeEntry({
        entryKey: 'glm-lower',
        requestedModel: 'glm-5',
        logicalModel: 'glm-5',
        concreteModel: 'glm-5',
        rawSourceModel: 'glm-5',
        canonicalModel: 'glm-5',
        canonicalModels: new Set(['glm-5']),
        aliasModels: new Set(['glm-5']),
      }),
    ];

    const buckets = buildBucketsForTest(entries, {
      name: 'test',
      models: ['GLM-5', 'glm-5'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-only',
      channelTypes: ['codex'],
    });

    expect(buckets).toHaveLength(2);
  });

  test('bundle-compatible gpt models can merge on same shared credential when each is single-valued', () => {
    const baseToken = { id: 100, name: 'metapi', token: 'tok', enabled: true };
    const entries = [
        makeEntry({
          entryKey: 'gpt-54',
          token: baseToken,
          requestedModel: 'gpt-5.4',
          logicalRouteId: 1099,
          logicalModel: 'gpt-5.4',
        concreteModel: 'gpt-5.4',
        rawSourceModel: 'gpt-5.4',
        canonicalModel: 'gpt-5.4',
        canonicalModels: new Set(['gpt-5.4']),
        aliasModels: new Set(['gpt-5.4']),
        bundleIds: new Set(['gpt-codex-family']),
      }),
        makeEntry({
          entryKey: 'gpt-53-codex',
          token: baseToken,
          requestedModel: 'gpt-5.3-codex',
          logicalRouteId: 1468,
          logicalModel: 'gpt-5.3-codex',
        concreteModel: 'gpt-5.3-codex',
        rawSourceModel: 'gpt-5.3-codex',
        canonicalModel: 'gpt-5.3-codex',
        canonicalModels: new Set(['gpt-5.3-codex']),
        aliasModels: new Set(['gpt-5.3-codex']),
        bundleIds: new Set(['gpt-codex-family']),
      }),
    ];

    const buckets = buildBucketsForTest(entries, {
      name: 'test',
      models: ['gpt-5.4', 'gpt-5.3-codex'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-only',
      channelTypes: ['codex'],
    });

    expect(buckets).toHaveLength(2);
    const output = buildOutputBucketsForTest(buckets, {
      name: 'test',
      models: ['gpt-5.4', 'gpt-5.3-codex'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-only',
      channelTypes: ['codex'],
    });

    expect(output.warnings).toEqual([]);
    const rows = rowsFromBuckets(output.buckets, {
      name: 'test',
      models: ['gpt-5.4', 'gpt-5.3-codex'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-only',
      channelTypes: ['codex'],
    });

    expect(output.buckets).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].models).toBe('gpt-5.3-codex,gpt-5.4');
  });

  test('shared-credential merge refuses ambiguous logical models that expand to multiple source rows', () => {
    const sharedToken = { id: 100, name: 'metapi', token: 'tok', enabled: true };
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'deepseek-a1',
          token: sharedToken,
          requestedModel: 'deepseek-v3.2',
          logicalRouteId: 1089,
          logicalModel: 'deepseek-v3.2',
          concreteModel: 'DeepSeek-V3.2',
          concreteRouteId: 412,
          rawSourceModel: 'DeepSeek-V3.2',
          canonicalModel: 'deepseek-v3.2',
          inferredCanonicalModel: 'deepseek-v3.2',
          canonicalModels: new Set(['deepseek-v3.2']),
          aliasModels: new Set(['deepseek-v3.2', 'DeepSeek-V3.2']),
        }),
        makeEntry({
          entryKey: 'deepseek-a2',
          token: sharedToken,
          requestedModel: 'deepseek-v3.2',
          logicalRouteId: 1089,
          logicalModel: 'deepseek-v3.2',
          concreteModel: 'deepseek-ai/deepseek-v3.2',
          concreteRouteId: 413,
          rawSourceModel: 'deepseek-ai/deepseek-v3.2',
          canonicalModel: 'deepseek-v3.2',
          inferredCanonicalModel: 'deepseek-v3.2',
          canonicalModels: new Set(['deepseek-v3.2']),
          aliasModels: new Set(['deepseek-v3.2', 'deepseek-ai/deepseek-v3.2']),
        }),
        makeEntry({
          entryKey: 'gpt-a',
          token: sharedToken,
          requestedModel: 'gpt-5.4',
          logicalRouteId: 1099,
          logicalModel: 'gpt-5.4',
          concreteModel: 'gpt-5.4',
          concreteRouteId: 1100,
          rawSourceModel: 'gpt-5.4',
          canonicalModel: 'gpt-5.4',
          inferredCanonicalModel: 'gpt-5.4',
          canonicalModels: new Set(['gpt-5.4']),
          aliasModels: new Set(['gpt-5.4']),
        }),
      ],
      {
        name: 'test',
        models: ['deepseek-v3.2', 'gpt-5.4'],
        entryMode: 'shared-credential',
        modelPackMode: 'merge',
        compatPolicy: 'metapi-inferred',
        channelTypes: ['codex'],
      },
    );

    const output = buildOutputBucketsForTest(buckets, {
      name: 'test',
      models: ['deepseek-v3.2', 'gpt-5.4'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'metapi-inferred',
      channelTypes: ['codex'],
    });

    expect(output.buckets).toHaveLength(3);
    expect(output.warnings[0]).toContain('多值 logical model');
  });

  test('shared-credential merge only merges models within the same allowed bundle cluster', () => {
    const sharedToken = { id: 100, name: 'metapi', token: 'tok', enabled: true };
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'gpt-54',
          token: sharedToken,
          requestedModel: 'gpt-5.4',
          logicalRouteId: 1099,
          logicalModel: 'gpt-5.4',
          concreteModel: 'gpt-5.4',
          rawSourceModel: 'gpt-5.4',
          canonicalModel: 'gpt-5.4',
          inferredCanonicalModel: 'gpt-5.4',
          canonicalModels: new Set(['gpt-5.4']),
          aliasModels: new Set(['gpt-5.4']),
          bundleIds: new Set(['gpt-codex-family']),
        }),
        makeEntry({
          entryKey: 'gpt-53',
          token: sharedToken,
          requestedModel: 'gpt-5.3-codex',
          logicalRouteId: 1468,
          logicalModel: 'gpt-5.3-codex',
          concreteModel: 'gpt-5.3-codex',
          rawSourceModel: 'gpt-5.3-codex',
          canonicalModel: 'gpt-5.3-codex',
          inferredCanonicalModel: 'gpt-5.3-codex',
          canonicalModels: new Set(['gpt-5.3-codex']),
          aliasModels: new Set(['gpt-5.3-codex']),
          bundleIds: new Set(['gpt-codex-family']),
        }),
        makeEntry({
          entryKey: 'grok',
          token: sharedToken,
          requestedModel: 'grok-4.1-fast',
          logicalModel: 'grok-4.1-fast',
          concreteModel: 'grok-4.1-fast',
          rawSourceModel: 'grok-4.1-fast',
          canonicalModel: 'grok-4.1-fast',
          inferredCanonicalModel: 'grok-4.1-fast',
          canonicalModels: new Set(['grok-4.1-fast']),
          aliasModels: new Set(['grok-4.1-fast']),
        }),
      ],
      {
        name: 'test',
        models: ['gpt-5.4', 'gpt-5.3-codex', 'grok-4.1-fast'],
        entryMode: 'shared-credential',
        modelPackMode: 'merge',
        compatPolicy: 'bundle-or-metapi-inferred',
        channelTypes: ['codex'],
      },
    );

    const output = buildOutputBucketsForTest(buckets, {
      name: 'test',
      models: ['gpt-5.4', 'gpt-5.3-codex', 'grok-4.1-fast'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-or-metapi-inferred',
      channelTypes: ['codex'],
    });

    const rows = rowsFromBuckets(output.buckets, {
      name: 'test',
      models: ['gpt-5.4', 'gpt-5.3-codex', 'grok-4.1-fast'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-or-metapi-inferred',
      channelTypes: ['codex'],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.models).sort()).toEqual([
      'gpt-5.3-codex,gpt-5.4',
      'grok-4.1-fast',
    ]);
  });

  test('shared-credential merge still normalizes source-flavored models to logical-group canonical names', () => {
    const sharedToken = { id: 100, name: 'metapi', token: 'tok', enabled: true };
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'glm-upper',
          token: sharedToken,
          requestedModel: 'glm-5',
          logicalRouteId: 1092,
          logicalModel: 'glm-5',
          concreteModel: 'GLM-5',
          rawSourceModel: 'GLM-5',
          canonicalModel: 'GLM-5',
          inferredCanonicalModel: 'GLM-5',
          canonicalModels: new Set(['GLM-5']),
          aliasModels: new Set(['glm-5', 'GLM-5']),
        }),
        makeEntry({
          entryKey: 'deepseek-source',
          token: sharedToken,
          requestedModel: 'deepseek-v3.1',
          logicalRouteId: 1088,
          logicalModel: 'deepseek-v3.1',
          concreteModel: 'deepseek-ai/deepseek-v3.1',
          rawSourceModel: 'deepseek-ai/deepseek-v3.1',
          canonicalModel: 'deepseek-ai/deepseek-v3.1',
          inferredCanonicalModel: 'deepseek-ai/deepseek-v3.1',
          canonicalModels: new Set(['deepseek-ai/deepseek-v3.1']),
          aliasModels: new Set(['deepseek-v3.1', 'deepseek-ai/deepseek-v3.1']),
        }),
      ],
      {
        name: 'test',
        models: ['glm-5', 'deepseek-v3.1'],
        entryMode: 'shared-credential',
        modelPackMode: 'merge',
        compatPolicy: 'bundle-or-metapi-inferred',
        channelTypes: ['codex'],
      },
    );

    const output = buildOutputBucketsForTest(buckets, {
      name: 'test',
      models: ['glm-5', 'deepseek-v3.1'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-or-metapi-inferred',
      channelTypes: ['codex'],
    });

    const rows = rowsFromBuckets(output.buckets, {
      name: 'test',
      models: ['glm-5', 'deepseek-v3.1'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-or-metapi-inferred',
      channelTypes: ['codex'],
    });

    expect(rows.map((row) => row.models).sort()).toEqual(['deepseek-v3.1', 'glm-5']);
    expect(rows[0].model_redirects === '{}' || rows[1].model_redirects === '{}').toBeFalse();
  });

  test('canonicalized single-source rows include redirect from logical canonical to raw source model', () => {
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'glm-upper',
          requestedModel: 'glm-5',
          logicalRouteId: 1092,
          logicalModel: 'glm-5',
          concreteModel: 'GLM-5',
          rawSourceModel: 'GLM-5',
          canonicalModel: 'GLM-5',
          inferredCanonicalModel: 'GLM-5',
          canonicalModels: new Set(['GLM-5']),
          aliasModels: new Set(['glm-5', 'GLM-5']),
        }),
      ],
      {
        name: 'test',
        models: ['glm-5'],
        entryMode: 'shared-credential',
        modelPackMode: 'merge',
        compatPolicy: 'bundle-or-metapi-inferred',
        channelTypes: ['codex'],
      },
    );

    const output = buildOutputBucketsForTest(buckets, {
      name: 'test',
      models: ['glm-5'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-or-metapi-inferred',
      channelTypes: ['codex'],
    });

    const rows = rowsFromBuckets(output.buckets, {
      name: 'test',
      models: ['glm-5'],
      entryMode: 'shared-credential',
      modelPackMode: 'merge',
      compatPolicy: 'bundle-or-metapi-inferred',
      channelTypes: ['codex'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].models).toBe('glm-5');
    expect(rows[0].model_redirects).toContain('"glm-5":"GLM-5"');
  });

  test('canonical-merge redirects aliases to bundle canonical model', () => {
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'opus-1',
          requestedModel: 'claude-opus-4.6',
          logicalModel: 'claude-opus-4.6',
          concreteModel: 'claude-opus-4-6',
          rawSourceModel: 'claude-opus-4-6',
          canonicalModel: 'claude-opus-4-6',
          canonicalModels: new Set(['claude-opus-4-6']),
          aliasModels: new Set(['claude-opus-4.6', 'claude-opus-4-6']),
          bundleIds: new Set(['claude-opus-46']),
        }),
        makeEntry({
          entryKey: 'opus-2',
          requestedModel: 'claude-opus-4.6',
          logicalModel: 'claude-opus-4.6',
          concreteModel: 'anthropic:claude-opus-4-6',
          rawSourceModel: 'anthropic:claude-opus-4-6',
          canonicalModel: 'claude-opus-4-6',
          canonicalModels: new Set(['claude-opus-4-6']),
          aliasModels: new Set(['anthropic:claude-opus-4-6', 'claude-opus-4.6']),
          bundleIds: new Set(['claude-opus-46']),
        }),
      ],
      {
        name: 'test',
        models: ['claude-opus-4.6'],
        entryMode: 'logical-bundle',
        modelPackMode: 'canonical-merge',
        compatPolicy: 'bundle-only',
        channelTypes: ['codex'],
      },
    );

    const rows = buildRowDraftsForTest(buckets, {
      name: 'test',
      models: ['claude-opus-4.6'],
      entryMode: 'logical-bundle',
      modelPackMode: 'canonical-merge',
      compatPolicy: 'bundle-only',
      channelTypes: ['codex'],
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.models).toBe('claude-opus-4-6');
      expect(row.model_redirects).toContain('claude-opus-4.6');
    }
  });

  test('metapi-inferred still prefers logical model as canonical request model inside one logical lineage', () => {
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'deepseek-entry',
          requestedModel: 'deepseek-v3.2',
          logicalRouteId: 555,
          logicalModel: 'deepseek-v3.2',
          concreteModel: 'deepseek-v3.2',
          rawSourceModel: 'deepseek-v3.2',
          canonicalModel: 'deepseek-v3.2',
          inferredCanonicalModel: 'deepseek-v3.2',
          canonicalModels: new Set(['deepseek-v3.2']),
          aliasModels: new Set(['deepseek-v3.2']),
          modelMappings: ['{"deepseek-v3.2":"DeepSeek-V3.2"}'],
        }),
      ],
      {
        name: 'test',
        models: ['deepseek-v3.2'],
        entryMode: 'logical-bundle',
        modelPackMode: 'canonical-merge',
        compatPolicy: 'metapi-inferred',
        channelTypes: ['codex'],
      },
    );

    const rows = buildRowDraftsForTest(buckets, {
      name: 'test',
      models: ['deepseek-v3.2'],
      entryMode: 'logical-bundle',
      modelPackMode: 'canonical-merge',
      compatPolicy: 'metapi-inferred',
      channelTypes: ['codex'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].models).toBe('deepseek-v3.2');
    expect(rows[0].model_redirects).toContain('deepseek-v3.2');
  });

  test('logical-bundle canonical-merge unifies logical group rows to one canonical request model', () => {
    const buckets = buildBucketsForTest(
      [
        makeEntry({
          entryKey: 'deepseek-a',
          logicalRouteId: 1089,
          requestedModel: 'deepseek-v3.2',
          logicalModel: 'deepseek-v3.2',
          concreteModel: 'deepseek-ai/deepseek-v3.2',
          rawSourceModel: 'deepseek-ai/deepseek-v3.2',
          canonicalModel: 'deepseek-ai/deepseek-v3.2',
          inferredCanonicalModel: 'deepseek-ai/deepseek-v3.2',
          canonicalModels: new Set(['deepseek-ai/deepseek-v3.2']),
          aliasModels: new Set(['deepseek-v3.2', 'deepseek-ai/deepseek-v3.2']),
        }),
        makeEntry({
          entryKey: 'deepseek-b',
          logicalRouteId: 1089,
          requestedModel: 'deepseek-v3.2',
          logicalModel: 'deepseek-v3.2',
          concreteModel: 'DeepSeek-V3.2',
          rawSourceModel: 'DeepSeek-V3.2',
          canonicalModel: 'DeepSeek-V3.2',
          inferredCanonicalModel: 'DeepSeek-V3.2',
          canonicalModels: new Set(['DeepSeek-V3.2']),
          aliasModels: new Set(['deepseek-v3.2', 'DeepSeek-V3.2']),
        }),
      ],
      {
        name: 'test',
        models: ['deepseek-v3.2'],
        entryMode: 'logical-bundle',
        modelPackMode: 'canonical-merge',
        compatPolicy: 'metapi-inferred',
        channelTypes: ['codex'],
      },
    );

    const rows = buildRowDraftsForTest(buckets, {
      name: 'test',
      models: ['deepseek-v3.2'],
      entryMode: 'logical-bundle',
      modelPackMode: 'canonical-merge',
      compatPolicy: 'metapi-inferred',
      channelTypes: ['codex'],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].models).toBe('deepseek-v3.2');
    expect(rows[1].models).toBe('deepseek-v3.2');
  });
});

function rowsFromBuckets(buckets: ReturnType<typeof buildBucketsForTest>, profile: Parameters<typeof buildRowDraftsForTest>[1]) {
  return buildRowDraftsForTest(buckets, profile);
}
