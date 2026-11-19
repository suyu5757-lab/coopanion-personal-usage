/**
 * Canonical digests of the built-in model-visible tool schemas.
 *
 * Three groups exist:
 * - the built-in Persona/World tools below, whose text lives in this repository;
 * - the opencode and codex World tools in `WORLD_TOOL_SCHEMA_ROOTS`, each bound to its World,
 *   exact tool name, schema revision and source file. `tests/tool-schema-roots.test.ts`
 *   recomputes every digest from the actual World definitions, so a schema edit that is not
 *   reflected here fails the test instead of silently widening the trust root;
 * - the two Owner-approved local voice tools in `VOICE_TOOL_SCHEMA_ROOTS`, whose digests are
 *   added to a request only after the installed package identity is verified at startup.
 *
 * Schema trust only says the tool definition is the reviewed one. Execution still goes through
 * Core → ActionGate → World → Receipt; it never grants a permission by itself.
 */

export interface WorldToolSchemaRoot {
  world: 'opencode' | 'codex';
  tool: string;
  digest: string;
  /** Exact source file and declaration the digest was computed from. */
  source: string;
  schemaRevision: string;
  /** Runtime environment the root is valid for. */
  environment: 'coopanion-core';
}

export const WORLD_TOOL_SCHEMA_ROOTS: readonly WorldToolSchemaRoot[] = [
  { world: 'opencode', tool: 'opencode_task', digest: 'ec47db836b2e5d5a6347db14c5bfc0c48ddc31ff6eac183b2d76ce78b0bd0385', source: 'packages/cortico-world-opencode/src/tools.ts', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'opencode', tool: 'opencode_stop', digest: '57c4a3c61cd62603c0eef08a670de0c856b349c6440a793e6cc779eccb5ee604', source: 'packages/cortico-world-opencode/src/tools.ts', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'opencode', tool: 'opencode_status', digest: '6cfa398eb580fd53197a60b868e263dd140bd29be261fa90cd432e7591df0f35', source: 'packages/cortico-world-opencode/src/tools.ts', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'opencode', tool: 'opencode_review', digest: 'ba7721af3f364d7453894296b0b6029b67e3ba48fb3f449902edbc2e95337cc7', source: 'packages/cortico-world-opencode/src/tools.ts', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'codex', tool: 'codex_task', digest: 'd7c0d3d809063ba9b89970e95d4a5fcee0daa7a8f6158c41859538ae9f5899b3', source: 'packages/cortico-world-codex/index.mjs', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'codex', tool: 'codex_status', digest: '5cc87b5d8f23b0a18c248fbcf00d768896e5bdd4b26de95984876e36915dccff', source: 'packages/cortico-world-codex/index.mjs', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'codex', tool: 'codex_review', digest: '9e8b2c8471e2c6fd1708d7733be2f217cf4d444f58c141f19f1f93065d87f55c', source: 'packages/cortico-world-codex/index.mjs', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
  { world: 'codex', tool: 'codex_stop', digest: 'bc2927eeddd91de76e54dfa260e09d2ca8f3fb642a127635d11da23aabc4ba82', source: 'packages/cortico-world-codex/index.mjs', schemaRevision: '2026-11-16', environment: 'coopanion-core' },
];

const BUILTIN_TOOL_SCHEMA_DIGESTS: readonly string[] = [
  'e33daf7b21b5d302bce41f1942b6904dfc999e47803a849124f432b7b0ab6f8a', // read_file
  '903be00fe2e681346f907fa894cc385564c917ca0b2f3592aa3105a7b3d784a5', // write_file
  '149c8a3c772fd0559613186775841bfba96976f67fe50aca8a46b747ba606cc6', // edit_file
  '111f9fc12b20cbe1bdda0ae6e628912999373f4e8370e1cdf7ec6dd7c76f5a78', // append_file
  '498122a0e72f921398557255700113f2826bba85924a53ef5ef23ecf6c8a071d', // delete_file
  'bc1963b567d5472389e30d411cd15b1566f2a5a33fe56aa47e9005f7f66bd18d', // list_files
  '32549242097a1af730743fa9e771146f9f90ebad8e8a0ad743781787412f3e4e', // glob_files
  '587657c63ff45e2bfa0279b1e9b3998fc19c2f2b63fe7532b26347b2e5860e4a', // grep_files
  '78503c97dcfba4d24d6e9e721bec320819e027585d3525e3f4322edda25d2149', // save_blob
  '6f174fff2e1a5e416ee5fa8bcc7d85337bced3a72ae2eb565f690f127822112b', // memory_search (source-safe; no source_id to the person)
  'f85aafb3dedfd00fb0fb5244f739b3644b5bf604ad09bab389d8ae9d7e363d09', // memory_remember
  'e27485ac542c932f000ce8e8ac1c54ffd427f9061a9bdd13f2e964d4b443aea5', // memory_correct
  'f5a215126a939bac6ab6e561819233795746b3e4432d210bda8714d3a3c65b96', // memory_forget
  'dd586e99185efe80abbc937c4680a2d11a4345abbe113cb11ac506ca297e18f8', // memory_reflect
  '5960eecb3ba2d35745a487262873f9cde887a6f086a6be07e8edf20d90fc2fd5', // pet_say
  'f8c9991d7e6e017d30f2799f091305b28a414f665bf49550bf8f5c0b7f5469f2', // pet_ask
  '61a627c0b7d300e3bb3028719aaf85eac7c8a6dde20dbe59d9220d800d3a6078', // pet_ask (non-CJK cap)
  '2ba24c39c25a543772cc246951749466e8afb898ecb881f3e90134556504d8cd', // pet_move_to
  'd7b6ecae6b46512872fed34127429d59309a3190dc72601a35cc6ed9c699bd17', // pet_set
  '24b25b3834e9d74ec23e1f013a7bad0104ab4ed4d17a1a73e4d169decbd15380', // pet_set (non-CJK cap)
  '2955bc466d6fb919269674acab46827391968e233ddea5fdc3d7041f036b564f', // pet_quiet
  'c28017cfd3dd08e8e362240b6118b740614f6d690782041168388cb8d713f226', // pet_act
  'a66ef84bfa0d5ef28fd1fd08b295e57a053e3cd9e03cc39d1744a4a7877da715', // end_turn
  '2cd825f3c61e7e4a8b4db5588c4309e6cc8b2e3e04159dcb10cb8449e9bda44d', // Growth memory_search
  'dd19007497d8dae4de72ed6381f2716d1d5df1ab1998b5c12be50bd61016b861', // propose_growth
  'c9ccf69ea604aa774820a5b2bd65a07433e2751735d1c9ea011916a9a6489dbb', // propose_experience
  'ab444af0aaa48bda6de9936b36d843b4af600ff03442ee2fc89a6716bfa34908', // finish_review
];

/**
 * Owner-authorized roots for the two local voice tools (Rev29 §0W, 2026-11-17).
 *
 * These are deliberately **not** part of `COOPANION_TOOL_SCHEMA_DIGESTS`. A schema digest alone
 * cannot tell two Worlds apart, so each root also names the exact installed package, version,
 * source file and source digest, and the only tool names that package may expose. The Host
 * (`core/voice-tool-trust.ts`) adds a digest to the request's trust set only when the installed
 * package, its source bytes and the World that will execute the tool all still match this table.
 * A changed digest, version or source fails closed: the tool stays invisible to the model.
 *
 * Trust here is still only about the tool definition. Execution goes through Core → World →
 * Receipt exactly as before, and `tts_control` / `audio_watch` are never exposed.
 */
export interface VoiceToolSchemaRoot {
  world: 'tts' | 'audio-play';
  package: string;
  packageVersion: string;
  tool: string;
  digest: string;
  /** Path inside the installed package. */
  source: string;
  sourceSha256: string;
  schemaRevision: string;
  /** The only tools this World may expose to the model in production. */
  exposes: readonly string[];
  /** Every tool the reviewed package declares; any other set fails closed. */
  declares: readonly string[];
  environment: 'coopanion-core';
}

export const VOICE_TOOL_SCHEMA_ROOTS: readonly VoiceToolSchemaRoot[] = [
  {
    world: 'tts',
    package: 'cortico-world-tts',
    packageVersion: '0.1.4',
    tool: 'tts_speak',
    digest: 'd79285615beb6baba43d3cce0355db0ebfa31bcf4c772c14d480163bf339a8d5',
    source: 'cortico-world-tts/src/world.js',
    sourceSha256: '47dceb04cea22bd490bd858f0a6a72ad3775ab233d206e508fdc14ad60b06d13',
    schemaRevision: 'rev29-owner-2026-11-17',
    exposes: ['tts_speak'],
    declares: ['tts_speak', 'tts_control'],
    environment: 'coopanion-core',
  },
  {
    world: 'audio-play',
    package: 'cortico-world-audio-play',
    packageVersion: '0.1.1',
    tool: 'audio_play',
    digest: 'a42236d17e6723ec55123870db796b8fd47b83d2ac3397ffe9986b9be3a45359',
    source: 'cortico-world-audio-play/src/world.js',
    sourceSha256: '84ddf468df16aec0fd3feb10b19b068af0cb165d3b3b256653bb6446bd2d36fd',
    schemaRevision: 'rev29-owner-2026-11-17',
    exposes: ['audio_play'],
    declares: ['audio_play', 'audio_watch'],
    environment: 'coopanion-core',
  },
];

export const COOPANION_TOOL_SCHEMA_DIGESTS: readonly string[] = [
  ...BUILTIN_TOOL_SCHEMA_DIGESTS,
  ...WORLD_TOOL_SCHEMA_ROOTS.map((root) => root.digest),
];
