/**
 * OSC address catalogue for the Helix Stadium editor protocol.
 *
 * Naming convention observed on the wire:
 *   - Editor -> device requests use PascalCase verbs (`/ParamValueSet`, `/SnapshotCountGet`).
 *   - Device -> editor responses/pushes use camelCase (`/setParamValue`, `/getSnapshotCount`).
 *   - Generic acks: `/status ,iii [cmdId, code, flag]`, `/success ,ii [cmdId, 0]`,
 *     `/error ,iis [cmdId, code, message]`.
 *
 * Sources: helix-stadium-tools docs/TECHNICAL_DETAILS.md and helix/session.py,
 * verified against a live Stadium XL by that project (MIT). Everything here is
 * unofficial, observational, and may change with firmware updates.
 */

/** Editor -> device (port 2002) request addresses. */
export const REQ = {
  ProductInfoGet: "/ProductInfoGet",
  EditBufferStateGet: "/EditBufferStateGet",
  PropertyValueGet: "/PropertyValueGet",
  PropertyValueSet: "/PropertyValueSet",
  ParamValueSet: "/ParamValueSet",
  HarnessParamValueSet: "/HarnessParamValueSet",
  BlockEnableSet: "/BlockEnableSet",
  ModelSet: "/ModelSet",
  ClrBlock: "/clrBlock",
  SplitDestinationSet: "/SplitDestinationSet",
  JoinOriginSet: "/JoinOriginSet",
  DoAgenda: "/doAgenda",
  SnapshotCountGet: "/SnapshotCountGet",
  ActiveSnapshotIndexGet: "/ActiveSnapshotIndexGet",
  SnapshotTargetsGet: "/SnapshotTargetsGet",
  ActivateSnapshot: "/activateSnapshot",
  SetSnapshotName: "/SetSnapshotName",
  CopySnapshot: "/CopySnapshot",
  SnapshotColorSet: "/SnapshotColorSet",
  LoadPresetWithCID: "/LoadPresetWithCID",
  LoadPresetAtContainerPosition: "/LoadPresetAtContainerPosition",
  SavePresetWithCID: "/SavePresetWithCID",
  GetContentRef: "/GetContentRef",
  GetContainerContents: "/GetContainerContents",
  GetContentData: "/GetContentData",
  GetContentPath: "/GetContentPath",
  GetAllContentInfo: "/GetAllContentInfo",
  GetContentInfo: "/GetContentInfo",
  SetContentInfo: "/SetContentInfo",
  DeleteContentInfo: "/DeleteContentInfo",
  FindContentMatches: "/FindContentMatches",
  SetContentAttrs: "/SetContentAttrs",
  SetContentData: "/SetContentData",
  SetContentPath: "/SetContentPath",
  AddContentsToContainer: "/AddContentsToContainer",
  ReorderContainerContent: "/ReorderContainerContent",
  RemoveContent: "/RemoveContent",
  PropertyDefWithKeyGet: "/PropertyDefWithKeyGet",
  MatchingPropertyDefinitionsGet: "/MatchingPropertyDefinitionsGet",
  MatchingPropertyValuesGet: "/MatchingPropertyValuesGet",
} as const;

/** Device -> editor response addresses (arrive on port 2002, correlated by cmdId). */
export const RESP = {
  Status: "/status",
  Success: "/success",
  Error: "/error",
  GetProductInfo: "/getProductInfo",
  GetEditBufferState: "/getEditBufferState",
  GetPropertyValue: "/getPropertyValue",
  GetSnapshotCount: "/getSnapshotCount",
  GetActiveSnapshotIndex: "/getActiveSnapshotIndex",
  GetSnapshotTargets: "/getSnapshotTargets",
  // Content responses reuse the request address:
  GetContentRef: "/GetContentRef",
  GetContainerContents: "/GetContainerContents",
  GetContentData: "/GetContentData",
  GetContentPath: "/GetContentPath",
  GetAllContentInfo: "/GetAllContentInfo",
  GetContentInfo: "/GetContentInfo",
  FindContentInfo: "/FindContentInfo",
  KeyPropertyDefinition: "/keyPropertyDefinition",
  GetMatchingPropertyDefinitions: "/getMatchingPropertyDefinitions",
  GetMatchingPropertyValues: "/getMatchingPropertyValues",
} as const;

/** Device -> editor push addresses (port 2001 subscribed stream). */
export const PUSH = {
  Heartbeat: "/heartbeat",
  SetParamValue: "/setParamValue",
  SetBlockEnable: "/setBlockEnable",
  SetModelWithMID: "/setModelWithMID",
  SetSnapshotName: "/setSnapshotName",
  ActivateSnapshot: "/activateSnapshot",
  SetPropertyValue: "/setPropertyValue",
  SetControllerValue: "/setControllerValue",
  SetSelectedBlock: "/setSelectedBlock",
  SyncMixChannelVolume: "/syncMixChannelVolume",
  SyncMixChannelPan: "/syncMixChannelPan",
  SyncMixChannelMute: "/syncMixChannelMute",
  SyncMixChannelSolo: "/syncMixChannelSolo",
  SyncMixAttachedOut: "/syncMixAttachedOut",
} as const;

/** Well-known container content ids. */
export const FACTORY_PRESETS_CID = -1;
export const USER_PRESETS_CID = -2;
export const SETLIST_DIRECTORY_CID = -5;

/**
 * /status error codes the device uses for DSP/resource exhaustion (observed
 * by the community mobile client). Map these to "not enough processing
 * headroom" instead of a generic failure.
 */
export const DEVICE_RESOURCE_STATUS_CODES: ReadonlySet<number> = new Set([
  -19, -8219, -8611, -8701, -8704, -8707,
]);

/** Human-readable explanation for a non-zero /status code. */
export function describeStatusCode(code: number): string {
  if (code === 0) return "ok";
  if (DEVICE_RESOURCE_STATUS_CODES.has(code)) {
    return `not enough processing headroom on the device (status ${code})`;
  }
  if (code === -4) return `invalid argument or position (status ${code})`;
  return `device rejected the command (status ${code})`;
}

/** Well-known property keys. */
export const PROPERTY_KEYS = {
  activePresetId: "server.active.preset.id",
  mixerState: "server.mixer.state",
  autoCabInsert: "global.modelselect.addcabblock",
  presetNotes: "preset.meta.info",
} as const;

/** Bonjour service type the device advertises. */
export const MDNS_SERVICE_TYPE = "_stadiumserver._tcp";

/**
 * Default ports. When Bonjour advertises a service port, the update/subscribe
 * stream uses that port and the command port is `port + 1`.
 */
export const DEFAULT_UPDATE_PORT = 2001;
export const DEFAULT_COMMAND_PORT = 2002;
