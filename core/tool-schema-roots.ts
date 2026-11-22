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
  world: 'opencode' | 'codex' | 'browser' | 'desktop-pet';
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
  // Bundled Browser World tools (Rev31 A4/N6). Execution still goes through ActionGate + Receipt.
  { world: 'browser', tool: 'browser_open', digest: '77f95b9e4fefac336f28bbeab518d2261ab44bb0a8aeb0cf334d75e4000b4231', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_search', digest: 'affe1822b7aad67c1e510518fc163dc9e0bdcabfabb3b72d4055a495200eae6d', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_read', digest: '669f7816caca38342a7ea44c56d2994b826ff11df9c45dfefb1d99b164028301', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_text', digest: 'acc9644bcc424b30b4e9e80a7354b7b440a04900e9add55ea31a527e27d2dc30', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_find', digest: '650875e06fa5f383545918a605bf5a901cae4df4de35beec288f68166c044d66', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_click', digest: '592df9613d8096908b8b7ae39312e8ee6f0d5e77196e67c5ec92d6192fb45af4', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_hover', digest: '878678e5a284e29c5eab922ecf630e8631565eea9d6ab6c03cb23a1b857b3185', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_share', digest: '480f37c613c7bcf4db7f14abf4b973bbcf89a59c93c27a10c4fec3f7c97155f6', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_type', digest: 'b94b7d1377d6362203307f971babc1a29a34fe2885159e188239e2a30bb04249', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_press', digest: 'c6cd8de37e533a0a3fb7f27487d92dfe6925207aff5df7e57627b1ef979b52c1', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_scroll', digest: '15c9f1effc3ac3d626bd8e0cc9efa9b995eceb7119b4ffa51de89288d86da10e', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_play', digest: '553cbea2eb9d06cbc3acd29c80d5ea10671e53464ab48577a0ac4a485af08269', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_watch', digest: 'e5422fcbba621b2a3642283cab86c6e6ba9a34cb562defe0474abd81451d7b75', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_screenshot', digest: 'f5baf8d6a87fe75c75d6e068c89864e36ee6320b04494d36b0b1d25e947c0289', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_chatgpt_generate_image', digest: '79a1b1745e2e76e910f69403820783bc0564fb6038820c9674ee07cf2793d567', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_chatgpt_image_status', digest: '480ff1e60cc713927c2f273340dcf402f592d981244d7bf71627bd69bbabfcea', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_save_chatgpt_image', digest: '0957d2aa9b6a7de8854bc4488f385007f4928dfea9353f529d14db9dee56b64a', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_gemini_generate_image', digest: 'cadf32ee5c6dc26ea7e56fe22088905349b28d7ab3e2ba5a061d15b6641dab22', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_gemini_image_status', digest: '6d8f948d7c7cf0d6582dd33e5e757c34d7a34ad1ac4a232912590f1f3d636fed', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_save_gemini_image', digest: '3fc41aafb5e36f6a7bf2c5178c4f3c3d1a561c298536d046952c7daa24d393c5', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_image_workspace', digest: 'b3234ac1910f4fa34ca28e454605e620428d886c1185d74236f13bdd79d81973', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_download_media', digest: '89338a8f30ec636c6c3d148ea7f304f6e2f9992881a807831a31baee1a5708fd', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_upload_media', digest: '4247e3f8876424cc603fcab2fc488478f30ac7408bb010b47cb980c280882e90', source: 'core/browser/tools.ts', schemaRevision: '2026-11-21', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_douyin_task', digest: '63c32de6b81e3095bd0ad04b65ee2e7a2607d0db68a5def11641065166fe0530', source: 'core/browser/tools.ts', schemaRevision: '2026-11-22', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_douyin_ops', digest: '6fc7507b9ed4daa35e1b344313fbb8b2df7e043e1487545f92956f32d2609b00', source: 'core/browser/tools.ts', schemaRevision: '2026-11-22', environment: 'coopanion-core' },
  { world: 'browser', tool: 'douyin_prepare_post', digest: 'b3ce56c10bfe61af80eeea9bd8d085b681df4de6df18dddc425352a3942a6e47', source: 'core/browser/tools.ts', schemaRevision: '2026-11-22', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_back', digest: '7a7ef3ac92455685dccc76a8bfdeafd2aa8120c42f091a8dee459112e68e81b7', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'browser', tool: 'browser_close', digest: '8c82b3673b9cdcc98d0265b180df629d9312f2773d169002a0ea3bfeb484f609', source: 'core/browser/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  // Bundled Desktop-Pet built-in CUA tools (Rev31 A4/N6). Execution still goes through ActionGate + Receipt.
  { world: 'desktop-pet', tool: 'pet_cua_screenshot', digest: '02db80a454f8f61fd4fb510b03fab06c654ff3ae913843551fac629e6fc3be25', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_zoom', digest: '576b19af51eb43de4b765fa623f568a21f1603ac2fa6874a266326afbfe0d03c', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_click', digest: 'a095179091da4e630768b99189d64f6f8b8b9ec85f3354509511850b4d29c86d', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_move', digest: '9d3f523ff2d86f0cad5c30f81bdc36938e8cdc0d3ba7dcf49c6d98ac370bebb9', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_drag', digest: 'ac435dad56ff950a700dd24c2059f21ec0c8dc140054585a067424ff6cf1fe1d', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_scroll', digest: 'f12d7cf252828ce678ded4512c0edc37f9513ccaba88aa044b7c703898a60c4d', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_type', digest: '633a9762412e3aa25aec71b6941907fe525ae3a6bf4e3257f0b661b7b4984850', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_key', digest: '187e5e3f738a87dc7eed23cd5624d319d6ed6d2b522a948462939e3286583ea4', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_windows', digest: '8c120aa932c7e9a7d4f1fc42954cdc3179be02eca4878981d370f726a6f56dac', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_window', digest: '53f2255ac19f73532d2c7bfa3891a564f38a77f5b48d3900992c37a0fea287e6', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_accessibility', digest: '7d9c45eefca117e01dc6127d2f30fa6c71cc7b718bab08f93a6eeb930988cd33', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_focus', digest: 'fe01f2315e2a2f6355f92ed169ef2763e1937ab2cecbe916b2c24dcdd1221b39', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_wait', digest: '0127c2d03e99fce22050623e9dcad2c593b072301abe7b7a9bf120ebfde7a9af', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
  { world: 'desktop-pet', tool: 'pet_cua_open_settings', digest: '802bf51ecaee7156b29601eb836ad4d822f74e490d4fe0cf21d184a8c188a581', source: 'packages/cortico-world-desktop-pet/src/cua/tools.ts', schemaRevision: '2026-11-20', environment: 'coopanion-core' },
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
