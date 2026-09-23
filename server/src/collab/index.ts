/**
 * Collaboration module (SPEC §4.4): Yjs doc rooms (CollabService) and project meta rooms
 * (MetaService), both y-websocket 3.1.0 wire compatible, built on y-protocols + lib0 + ws.
 *
 *   createCollabService(s, opts?)  →  /ws/doc/:projectId/:fileId?epoch=N
 *   createMetaService(s, opts?)    →  /ws/project/:projectId
 *   applyTextDiff(ytext, next)     →  minimal-diff text replacement (never swap a Y.Doc)
 *
 * Deviations from the letter of the SPEC (the public contract is unchanged):
 *  - Client doc updates are validated before they are applied: only plain string content in the
 *    DOC_TEXT_KEY Y.Text is accepted (no other shared types, embeds, formatting or '\r'), and an
 *    update that would push the text beyond MAX_DOC_LENGTH is refused (close 4413) instead of
 *    being applied first; the post-apply 4413 check is kept for updates that integrate late.
 *  - The sidecar has a small header (text hashes + lineage) in front of the Yjs update, used to
 *    recognise a crash between the sidecar and text writes and to refuse clients whose state comes
 *    from a lost earlier Y.Doc of the same file (closed with 4409 so they start over instead of
 *    duplicating the text).
 *  - Awareness states are relayed with the connection's authenticated identity (`user` is replaced
 *    by the db user), and a connection can only publish/remove states of its own client ids.
 *  - Viewers' SyncStep2/Update messages are still never applied, but one that holds anything the
 *    server does not have (a real edit — typically made offline by an editor who was made a
 *    viewer meanwhile) closes that connection with 4403 instead of being dropped silently, so
 *    the client re-checks its role and keeps its text aside; a viewer's ordinary sync (nothing
 *    new) keeps its connection. See DocRoom.onSyncMessage.
 *  - history.noteActivity is throttled to once per second per file and user on the trailing
 *    edge too (an edit inside the window is reported at its end, never dropped), and
 *    `editCount(pid)` counts every applied change for history's "nothing changed" shortcut.
 *  - The meta doc is persisted in `ystate/<pid>/_project-meta.ybin` (see meta-service.ts).
 *  - The optional second parameter of the factories (timings, logger) exists for tests and
 *    for main.ts to inject its logger; main.ts may call them with `s` only.
 */
export { createCollabService, DEFAULT_COLLAB_OPTIONS } from './collab-service.ts'
export type { CollabOptions, CollabRoomInfo, CollabServiceImpl, DocUpgradeContext } from './collab-service.ts'
export { createMetaService, DEFAULT_META_OPTIONS } from './meta-service.ts'
export type { MetaOptions, MetaServiceImpl, MetaUpgradeContext } from './meta-service.ts'
export { applyTextDiff, diffTexts } from './text-diff.ts'
export type { CollabLogger } from './log.ts'
