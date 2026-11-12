/**
 * The TUI's quota data: the server's last snapshot, kept in Solid signals so every surface
 * redraws when it changes. It asks the server over the quota RPC (`snapshot` when a surface
 * shows, `refresh` after a turn), applies every `changed` event, and asks again every minute
 * in case an event was missed. Nothing reaches OpenCode until a surface shows or a turn ends.
 *
 * Answers can arrive out of order. The newest snapshot per credential source wins; a snapshot
 * from another server (a new `serverId`: OpenCode restarted it) always wins, as its revisions
 * start over, and from then on the old server's answers are ignored. A session's model follows
 * its newest revision; its token totals come from the latest call about it.
 *
 * Every TUI on a shared background service hears the `changed` events of every folder, and each
 * folder's server plugin has its own `serverId`. So a TUI takes only the events of its own
 * folder (`ownFolderEvents`); another folder's would look like a restart and retire its server.
 */
import { createSignal } from "solid-js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { QuotaRpc, } from "../rpc.js";
const POLL_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;
/** Expire old sessions outside the most recently read unwatched sessions; always keep watched ones. */
const SESSION_VIEW_KEEP_MS = 5 * 60_000;
const SESSION_VIEW_KEEP_COUNT = 20;
function hostLocation(host) {
    return host.location ?? host.data.location?.default();
}
/**
 * The `acceptsEventFrom` of a TUI: only events from the folder its calls name, read when each
 * event arrives. An event that names no folder is dropped; the minute poll still updates.
 */
export function ownFolderEvents(host) {
    return (location) => {
        const own = hostLocation(host);
        return own !== undefined && location?.directory === own.directory;
    };
}
/**
 * Each call names the TUI's folder, so the server uses that folder's settings, and gives up
 * after a minute. The RPC client itself is made per call, never during setup.
 */
export function quotaCallOptions(host) {
    const location = hostLocation(host);
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    if (location)
        return { location, signal };
    if (host.locationOptional)
        return { signal };
    throw new Error("OpenCode gave the TUI no location");
}
/** RPC calls reject with a plain `{ type, message }` object, not an Error. */
export function rpcErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "object" && error !== null && "message" in error) {
        return String(error.message);
    }
    return String(error);
}
/** The toast for a failed call: its reason, cleaned for the terminal. */
export function errorToast(error, title = "OpenCode Quota") {
    const message = sanitizeDisplayText(rpcErrorMessage(error));
    return { variant: "error", title, message };
}
export function reportFailure(error) {
    // OpenCode answers rpc.unavailable when no server plugin registered the quota RPC here.
    const hint = typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "rpc.unavailable"
        ? " (OpenCode Quota's server plugin is not loaded for this folder)"
        : "";
    console.warn(`[opencode-quota] failed to load quota: ${rpcErrorMessage(error)}${hint}`);
}
/**
 * @param onSnapshot called with every snapshot the client takes (from any call or event), so
 *   toasts can announce new reset notices.
 * @param onFailure called when a `snapshot` or `refresh` call made since the last `start()`
 *   fails, so a GUI window can say why it shows nothing or an older snapshot. A call made
 *   through an earlier `host.client` (a server since restarted) reports nothing here.
 */
export function createQuotaClient(host, onSnapshot = () => { }, onFailure = () => { }) {
    const [latest, setLatest] = createSignal();
    const [sources, setSources] = createSignal({});
    const [sessions, setSessions] = createSignal({});
    const [defaultScope, setDefaultScope] = createSignal();
    const [homeLine, setHomeLine] = createSignal("");
    /** Sessions on screen, with how many surfaces show each. */
    const watched = new Map();
    /** Surfaces on screen without a session (the status line on Home). */
    let globalWatchers = 0;
    let homeWatchers = 0;
    let running = false;
    /** Numbers every call; session token totals come only from a later call than the last one. */
    let calls = 0;
    const sessionCalls = new Map();
    const sessionRevisions = new Map();
    /** Least recently read first, including reads in the same millisecond. */
    const sessionReads = new Map();
    /** Servers this client moved away from; their answers are ignored. */
    const retiredServers = new Set();
    /** Bumped when the TUI stops: answers to calls made before then are dropped. */
    let mount = 0;
    /** Snapshot calls on their way, by session ("" for none), with their call numbers. */
    const loading = new Map();
    /** The `changed` subscription while running, made with the first snapshot call. */
    let events;
    const rpc = () => host.client.rpc(QuotaRpc);
    function forgetInactiveSessions() {
        const cutoff = Date.now() - SESSION_VIEW_KEEP_MS;
        const expired = [];
        let recent = 0;
        for (const [id, read] of [...sessionReads].reverse()) {
            if (watched.has(id))
                continue;
            recent += 1;
            if (recent <= SESSION_VIEW_KEEP_COUNT || read.atMs > cutoff)
                continue;
            sessionReads.delete(id);
            sessionCalls.delete(id);
            sessionRevisions.delete(id);
            expired.push(id);
        }
        if (expired.length === 0)
            return;
        setSessions((all) => {
            const kept = { ...all };
            for (const id of expired)
                delete kept[id];
            return kept;
        });
    }
    function readSession(sessionID) {
        forgetInactiveSessions();
        if (!sessionID)
            return undefined;
        const read = sessionReads.get(sessionID) ?? { atMs: Date.now() };
        read.atMs = Date.now();
        sessionReads.delete(sessionID);
        sessionReads.set(sessionID, read);
        return read;
    }
    /** `call` numbers the request a session's part came from. */
    function apply(snapshot, session) {
        forgetInactiveSessions();
        const { sessionID: snapshotSessionID, currentModelProviderIds, currentModelRowPrefixes, sessionTokens, ...shared } = snapshot;
        if (retiredServers.has(shared.serverId))
            return;
        // An answer that left before a newer snapshot arrived must not undo it.
        const current = latest();
        if (current && current.serverId !== shared.serverId) {
            retiredServers.add(current.serverId);
            setSources({});
            sessionRevisions.clear();
        }
        if (!current || current.serverId !== shared.serverId || current.revision < shared.revision) {
            setLatest(shared);
        }
        const scope = shared.sourceScope ?? "";
        const previous = sources()[scope];
        if (!previous || previous.revision < shared.revision) {
            setSources((all) => ({ ...all, [scope]: shared }));
        }
        if (session && !session.id)
            setDefaultScope(scope);
        const sessionID = session?.id ?? snapshotSessionID;
        // An old event or a late answer cannot recreate an expired session's records.
        const read = sessionID ? sessionReads.get(sessionID) : undefined;
        if (sessionID && read && (!session || session.read === read)) {
            const newerCall = session && session.call > (sessionCalls.get(sessionID) ?? 0);
            const newerModel = shared.revision > (sessionRevisions.get(sessionID) ?? 0);
            if (newerCall)
                sessionCalls.set(sessionID, session.call);
            if (newerModel)
                sessionRevisions.set(sessionID, shared.revision);
            setSessions((all) => ({
                ...all,
                [sessionID]: {
                    ...all[sessionID],
                    ...(newerModel
                        ? { sourceScope: shared.sourceScope, currentModelProviderIds, currentModelRowPrefixes }
                        : {}),
                    ...(newerCall ? { sessionTokens } : {}),
                },
            }));
        }
        // Settings are shared; reset notices, like rows, belong only to sources this TUI uses.
        const active = [...watched.keys()].some((id) => sessions()[id] && (sessions()[id].sourceScope ?? "") === scope);
        const requested = session?.notices && (!session.id || (sessions()[session.id]?.sourceScope ?? "") === scope);
        onSnapshot(requested || active || (globalWatchers > 0 && scope === (defaultScope() ?? ""))
            ? snapshot
            : { ...snapshot, resetNotices: [] });
    }
    function subscribe() {
        if (!running || events)
            return;
        events = new AbortController();
        const signal = events.signal;
        try {
            rpc().events.on("changed", (event) => {
                if (signal.aborted)
                    return;
                if (host.acceptsEventFrom && !host.acceptsEventFrom(event.location))
                    return;
                apply(event.data.snapshot);
            }, { signal });
        }
        catch (error) {
            // The poll still updates every minute.
            reportFailure(error);
        }
    }
    function load(sessionID) {
        // The sidebar and the status line of one session ask together; one call answers both.
        const key = sessionID ?? "";
        if (loading.has(key))
            return;
        const read = readSession(sessionID);
        const call = ++calls;
        const at = mount;
        const client = host.client;
        loading.set(key, call);
        subscribe();
        let request;
        try {
            request = rpc().snapshot(sessionID ? { sessionID } : {}, quotaCallOptions(host));
        }
        catch (error) {
            // A client without the RPC, or no folder to name: fail like a rejected call.
            request = Promise.reject(error);
        }
        request
            .then((output) => {
            if (at === mount)
                apply(output.snapshot, { id: sessionID, call, read });
        })
            .catch((error) => {
            if (at === mount && host.client === client)
                onFailure(error);
            reportFailure(error);
        })
            .finally(() => {
            if (loading.get(key) === call)
                loading.delete(key);
        });
    }
    function loadHomeLine() {
        const at = mount;
        rpc()
            .notices({}, quotaCallOptions(host))
            .then((output) => {
            if (at === mount)
                setHomeLine(output.homeLine);
        })
            .catch(reportFailure);
    }
    function snapshot(sessionID) {
        const shared = latest();
        if (!shared)
            return undefined;
        const part = sessionID ? sessions()[sessionID] : undefined;
        const read = sessionID ? sessionReads.get(sessionID) : undefined;
        if (sessionID && read) {
            read.atMs = Date.now();
            sessionReads.delete(sessionID);
            sessionReads.set(sessionID, read);
        }
        if (sessionID && !part && shared.sourceScope)
            return undefined;
        const scope = part ? (part.sourceScope ?? "") : (defaultScope() ?? shared.sourceScope ?? "");
        const source = sources()[scope];
        if (!source)
            return undefined;
        const { sourceScope: _scope, ...common } = shared;
        return {
            ...common,
            providers: source.providers,
            resetNotices: source.resetNotices,
            ...(source.sourceScope ? { sourceScope: source.sourceScope } : {}),
            ...part,
        };
    }
    function poll() {
        forgetInactiveSessions();
        if (globalWatchers > 0)
            load();
        for (const sessionID of watched.keys())
            load(sessionID);
        if (homeWatchers > 0)
            loadHomeLine();
    }
    return {
        snapshot,
        homeLine,
        watch(sessionID) {
            if (!sessionID) {
                globalWatchers += 1;
                load();
                return () => {
                    globalWatchers -= 1;
                };
            }
            watched.set(sessionID, (watched.get(sessionID) ?? 0) + 1);
            load(sessionID);
            return () => {
                const count = (watched.get(sessionID) ?? 1) - 1;
                if (count > 0)
                    watched.set(sessionID, count);
                else
                    watched.delete(sessionID);
            };
        },
        watchHome() {
            homeWatchers += 1;
            loadHomeLine();
            return () => {
                homeWatchers -= 1;
            };
        },
        async refresh(reason, sessionID) {
            const read = readSession(sessionID);
            const call = ++calls;
            const at = mount;
            const client = host.client;
            try {
                const input = sessionID ? { reason, sessionID } : { reason };
                subscribe();
                const output = await rpc().refresh(input, quotaCallOptions(host));
                if (at !== mount)
                    return undefined;
                apply(output.snapshot, { id: sessionID, call, notices: true, read });
                return snapshot(sessionID);
            }
            catch (error) {
                if (at === mount && host.client === client)
                    onFailure(error);
                reportFailure(error);
                return undefined;
            }
        },
        start() {
            running = true;
            // After a reconnect, the surfaces already on screen ask again at once.
            poll();
            const timer = setInterval(poll, POLL_INTERVAL_MS);
            let stopped = false;
            return () => {
                if (stopped)
                    return;
                stopped = true;
                running = false;
                mount += 1;
                loading.clear();
                events?.abort();
                events = undefined;
                clearInterval(timer);
            };
        },
    };
}
//# sourceMappingURL=client.js.map