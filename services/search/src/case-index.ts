import { Client } from '@opensearch-project/opensearch';

// The OpenSearch index of test cases (HLD §6). Every read and write goes through the `cases` alias,
// never a physical index name, so a full reindex can build a new index and swap the alias atomically.
//
// ponytail: one shared index routed by project. HLD §6.1 moves projects above ~1M cases to their own
// index; add that when a project gets there (the alias indirection already allows it).

export const ALIAS = 'cases';

export interface CaseDocument {
  org_id: string;
  project_id: string;
  case_id: string;
  key_no: number;
  key: string;
  title: string;
  steps_text: string;
  module_id: string;
  /** The module and all its ancestors, so `module = UPI` matches everything under UPI. */
  module_ids: string[];
  module_path: string;
  /** Tree order (the module's ltree path), for sorting and grouping by module. */
  module_sort: string;
  priority: string;
  /** P0 → 0, P3 → 3: lets `priority >= P1` be a range query. */
  priority_rank: number;
  status: string;
  last_result: string;
  automation: string;
  type: string;
  labels: string[];
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  estimate_min: number | null;
  updated_at: string;
  created_at: string;
  last_run_at: string | null;
}

const MAPPINGS = {
  dynamic: 'strict',
  properties: {
    org_id: { type: 'keyword' },
    project_id: { type: 'keyword' },
    case_id: { type: 'keyword' },
    key_no: { type: 'integer' },
    key: { type: 'keyword' },
    title: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 512 } } },
    steps_text: { type: 'text' },
    module_id: { type: 'keyword' },
    module_ids: { type: 'keyword' },
    module_path: { type: 'keyword' },
    module_sort: { type: 'keyword' },
    priority: { type: 'keyword' },
    priority_rank: { type: 'byte' },
    status: { type: 'keyword' },
    last_result: { type: 'keyword' },
    automation: { type: 'keyword' },
    type: { type: 'keyword' },
    labels: { type: 'keyword' },
    owner_id: { type: 'keyword' },
    owner_name: { type: 'keyword' },
    owner_email: { type: 'keyword' },
    estimate_min: { type: 'integer' },
    updated_at: { type: 'date' },
    created_at: { type: 'date' },
    last_run_at: { type: 'date' },
  },
} as const;

export class CaseIndex {
  readonly client: Client;

  constructor(node: string) {
    this.client = new Client({ node });
  }

  /** Creates the first index and alias when neither exists (fresh local stack). */
  async ensure(replicas = 0): Promise<void> {
    const exists = await this.client.indices.existsAlias({ name: ALIAS });
    if (exists.body) return;
    const name = await this.createPhysical(replicas);
    await this.client.indices.putAlias({ index: name, name: ALIAS });
  }

  async createPhysical(replicas = 0): Promise<string> {
    const name = `${ALIAS}-${Date.now()}`;
    await this.client.indices.create({
      index: name,
      body: {
        settings: { number_of_shards: 2, number_of_replicas: replicas, refresh_interval: '1s' },
        mappings: MAPPINGS,
      },
    });
    return name;
  }

  /** Writes documents in one bulk request; refresh makes them searchable before the call returns (tests, UI). */
  async upsert(docs: CaseDocument[], target = ALIAS, refresh: boolean | 'wait_for' = false): Promise<void> {
    if (!docs.length) return;
    const body = docs.flatMap((d) => [
      { index: { _index: target, _id: d.case_id, routing: d.project_id } },
      d,
    ]);
    const res = await this.client.bulk({ body, refresh });
    if (res.body.errors) {
      const first = res.body.items.find((i: { index?: { error?: unknown } }) => i.index?.error);
      throw new Error(`bulk index failed: ${JSON.stringify(first?.index?.error)}`);
    }
  }

  /** Points the alias at a freshly built index and drops the old one, in one atomic alias update. */
  async swapAlias(newIndex: string): Promise<void> {
    const current = await this.client.indices.getAlias({ name: ALIAS }).catch(() => ({ body: {} }));
    const old = Object.keys(current.body as Record<string, unknown>);
    await this.client.indices.updateAliases({
      body: {
        actions: [
          ...old.map((index) => ({ remove: { index, alias: ALIAS } })),
          { add: { index: newIndex, alias: ALIAS } },
        ],
      },
    });
    for (const index of old) await this.client.indices.delete({ index });
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()).body === true;
    } catch {
      return false;
    }
  }
}
