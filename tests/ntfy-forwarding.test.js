// Zero-dependency verification for ntfy forwarding.
// Run from the extension root:  node tests/ntfy-forwarding.test.js
//
// Loads the real dist/background.js and dist/content.js inside a VM with a
// stubbed `chrome` API and `fetch`, then checks:
//   1. one new study -> one browser notification + one ntfy POST
//   2. forwarded title / reward / reward-per-hour match the original notification
//   3. duplicate detection (content.js) prevents a second "new-studies" message
//   4. a failing fetch does not affect the browser notification
//   5. nothing is sent when forwarding is disabled / topic empty / topic invalid

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND_SRC = fs.readFileSync(path.join(ROOT, "dist/background.js"), "utf8");
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, "dist/content.js"), "utf8");

const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(err));

// ---------- chrome.* stubs ----------
function makeStorageArea(initial) {
    const data = Object.assign({}, initial);
    return {
        get(keys, cb) {
            const keyList = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const k of keyList) {
                if (data[k] !== undefined) result[k] = data[k];
            }
            if (cb) cb(result);
            return Promise.resolve(result);
        },
        set(values) {
            Object.assign(data, values);
            return Promise.resolve();
        },
        _data: data,
    };
}

function makeChrome({ sync = {}, local = {} } = {}) {
    const calls = { notifications: [], sendMessage: [] };
    const listeners = { onMessage: [] };
    const chrome = {
        offscreen: {
            Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
            createDocument: async () => {},
        },
        runtime: {
            ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
            onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
            onInstalled: { addListener() {} },
            onStartup: { addListener() {} },
            getURL: (p) => "chrome-extension://test/" + p,
            getContexts: async () => [{}],
            sendMessage: async (m) => { calls.sendMessage.push(m); },
            setUninstallURL() {},
        },
        notifications: {
            onClicked: { addListener() {} },
            onButtonClicked: { addListener() {} },
            create: (id, opts) => { calls.notifications.push({ id, opts }); },
            clear() {},
        },
        tabs: {
            create: async () => {},
            query: async () => [],
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
        },
        action: {
            setBadgeText: async () => {},
            setBadgeBackgroundColor: async () => {},
        },
        storage: { sync: makeStorageArea(sync), local: makeStorageArea(local) },
    };
    return { chrome, calls, listeners };
}

function loadBackground({ fetchImpl, sync }) {
    const { chrome, calls, listeners } = makeChrome({ sync });
    const fetchCalls = [];
    const sandbox = {
        chrome, console, setTimeout, clearTimeout, Promise, TextEncoder, btoa,
        fetch: (url, init) => {
            fetchCalls.push({ url, init });
            return fetchImpl(url, init);
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(BACKGROUND_SRC, sandbox, { filename: "background.js" });
    const dispatch = (msg) => Promise.all(listeners.onMessage.map((fn) => fn(msg)));
    return { sandbox, calls, fetchCalls, dispatch };
}

function loadContent({ sync, local }) {
    const { chrome, calls } = makeChrome({ sync, local });
    const sandbox = {
        chrome, console, Promise, setTimeout, setInterval, clearInterval,
        MutationObserver: class { observe() {} disconnect() {} },
        document: { body: {}, querySelector: () => null },
    };
    vm.createContext(sandbox);
    vm.runInContext(CONTENT_SRC, sandbox, { filename: "content.js" });
    return { sandbox, calls, chrome };
}

// Minimal fake of one <li class="list-item"> study card as content.js reads it.
function fakeStudyNode(study) {
    const fields = {
        '[data-testid="title"]': study.title,
        '[data-testid="host"]': `By ${study.researcher}`,
        '[data-testid="study-tag-reward"]': study.reward,
        '[data-testid="study-tag-reward-per-hour"]': study.rewardPerHour + "/hr",
        '[data-testid="study-tag-completion-time"]': study.time,
    };
    return {
        getAttribute: (name) => (name === "data-testid" ? `study-${study.id}` : null),
        querySelector: (sel) => (fields[sel] != null ? { textContent: fields[sel] } : null),
    };
}

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const okFetch = async () => ({ ok: true, status: 200 });

const BASE_SYNC = {
    showNotification: true,
    audioActive: false,
    focusProlific: false,
    useOld: false,
    ntfyActive: true,
    ntfyTopic: "prolific-test-topic",
};

const STUDY = {
    id: "abc123",
    title: "Evaluate speech quality in generated videos",
    researcher: "Example Lab",
    reward: "$10.00",
    rewardPerHour: "$20.00",
    time: "30 mins",
    timeInMinutes: 30,
    createdAt: new Date().toISOString(),
};

// ---------- tests ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("1+2: one new study -> one browser notification and one matching ntfy POST", async () => {
    const bg = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    await bg.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
    await flush();

    assert.strictEqual(bg.calls.notifications.length, 1, "exactly one browser notification");
    assert.strictEqual(bg.fetchCalls.length, 1, "exactly one ntfy request");

    const notif = bg.calls.notifications[0];
    const req = bg.fetchCalls[0];

    // Browser notification: study title + bulleted details.
    assert.strictEqual(notif.id, STUDY.id);
    assert.strictEqual(notif.opts.title, STUDY.title);
    assert.strictEqual(
        notif.opts.message,
        "• Reward: $10.00\n• Reward per hour: $20.00\n• Time: 30 mins\n• By Example Lab"
    );
    assert.ok(!notif.opts.message.includes("A new study is available"));

    // ntfy request mirrors it exactly.
    assert.strictEqual(req.url, "https://ntfy.sh/prolific-test-topic");
    assert.strictEqual(req.init.method, "POST");
    assert.strictEqual(req.init.headers.Title, STUDY.title);
    assert.strictEqual(req.init.headers.Click, `https://app.prolific.com/studies/${STUDY.id}`);
    assert.strictEqual(req.init.body, notif.opts.message, "ntfy body equals the browser notification body");
});

test("2b: missing fields are omitted rather than faked", async () => {
    const bg = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    const partial = { id: "nofields", title: null, researcher: null, reward: null, rewardPerHour: null, time: null };
    await bg.dispatch({ target: "background", type: "new-studies", data: [partial] });
    await flush();

    assert.strictEqual(bg.calls.notifications.length, 1);
    assert.strictEqual(bg.fetchCalls.length, 1);
    const req = bg.fetchCalls[0];
    assert.strictEqual(req.init.headers.Title, "Prolific", "falls back to the ntfy default title");
    assert.strictEqual(req.init.body, "A new study is available on Prolific!", "generic text only when no details exist");
    assert.ok(!req.init.body.includes("Reward"));
    assert.ok(!req.init.body.includes("By "));
    assert.strictEqual(bg.calls.notifications[0].opts.title, "Prolific Automatic Studies");
});

test("2d: a study with only some fields lists just those bullets", async () => {
    const bg = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    const study = { id: "some", title: "Short survey", researcher: null, reward: "£2.50", rewardPerHour: null, time: "10 mins" };
    await bg.dispatch({ target: "background", type: "new-studies", data: [study] });
    await flush();
    assert.strictEqual(bg.calls.notifications[0].opts.title, "Short survey");
    assert.strictEqual(bg.calls.notifications[0].opts.message, "• Reward: £2.50\n• Time: 10 mins");
    assert.strictEqual(bg.fetchCalls[0].init.body, "• Reward: £2.50\n• Time: 10 mins");
});

test("2c: non-ASCII titles are RFC 2047 encoded for the header", async () => {
    const bg = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    const study = Object.assign({}, STUDY, { id: "utf8", title: "Étude — café ☕" });
    await bg.dispatch({ target: "background", type: "new-studies", data: [study] });
    await flush();

    const title = bg.fetchCalls[0].init.headers.Title;
    assert.ok(title.startsWith("=?UTF-8?B?") && title.endsWith("?="), `got ${title}`);
    const decoded = Buffer.from(title.slice(10, -2), "base64").toString("utf8");
    assert.strictEqual(decoded, "Étude — café ☕");
});

test("3: duplicate detection in content.js prevents a second new-studies message", async () => {
    const ct = loadContent({ sync: { trackIds: true, studyHistoryLen: 100 }, local: { currentStudies: [] } });
    const targetNode = { querySelectorAll: () => [fakeStudyNode(STUDY)] };

    await ct.sandbox.extractAndSendStudies(targetNode);
    await ct.sandbox.extractAndSendStudies(targetNode);
    await ct.sandbox.extractAndSendStudies(targetNode);

    const newStudyMessages = ct.calls.sendMessage.filter((m) => m.type === "new-studies");
    assert.strictEqual(newStudyMessages.length, 1, "same study seen three times -> one message");
    assert.strictEqual(newStudyMessages[0].data.length, 1);
    assert.strictEqual(newStudyMessages[0].data[0].id, STUDY.id);
    assert.deepStrictEqual(ct.chrome.storage.local._data.currentStudies.map((s) => s.id), [STUDY.id]);

    // End-to-end: that single message yields a single ntfy request.
    const bg = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    await bg.dispatch({ target: "background", ...newStudyMessages[0] });
    await flush();
    assert.strictEqual(bg.calls.notifications.length, 1);
    assert.strictEqual(bg.fetchCalls.length, 1);
});

test("7: researcher allowlist in content.js keeps only matching researchers", async () => {
    const other = Object.assign({}, STUDY, { id: "other1", researcher: "Someone Else" });
    const noResearcher = Object.assign({}, STUDY, { id: "anon1", researcher: "" });
    const run = async (whitelist) => {
        const ct = loadContent({
            sync: { trackIds: true, studyHistoryLen: 100, researcherWhitelist: whitelist },
            local: { currentStudies: [] },
        });
        const targetNode = { querySelectorAll: () => [fakeStudyNode(STUDY), fakeStudyNode(other), fakeStudyNode(noResearcher)] };
        await ct.sandbox.extractAndSendStudies(targetNode);
        const msgs = ct.calls.sendMessage.filter((m) => m.type === "new-studies");
        return msgs.length ? msgs[0].data.map((s) => s.id) : [];
    };

    assert.deepStrictEqual(await run(["example lab"]), [STUDY.id], "only the allowed researcher passes");
    assert.deepStrictEqual(await run(["EXAMPLE"]), [STUDY.id], "case-insensitive substring match");
    assert.deepStrictEqual(await run(["nobody"]), [], "no match -> nothing notified");
    assert.deepStrictEqual(await run([]), [STUDY.id, "other1", "anon1"], "empty allowlist -> everyone allowed");
    assert.deepStrictEqual(await run(undefined), [STUDY.id, "other1", "anon1"], "missing setting -> everyone allowed");
});

test("8: minimum reward filters are in dollars; pound rewards are skipped when a minimum is set", async () => {
    const usd8 = Object.assign({}, STUDY, { id: "usd8", reward: "$8.00", rewardPerHour: "$16.00" });
    const usd12 = Object.assign({}, STUDY, { id: "usd12", reward: "$12.00", rewardPerHour: "$24.00" });
    const gbp9 = Object.assign({}, STUDY, { id: "gbp9", reward: "£9.00", rewardPerHour: "£18.00" });
    const run = async (filters) => {
        const ct = loadContent({
            sync: Object.assign({ trackIds: true, studyHistoryLen: 100 }, filters),
            local: { currentStudies: [] },
        });
        const targetNode = { querySelectorAll: () => [fakeStudyNode(usd8), fakeStudyNode(usd12), fakeStudyNode(gbp9)] };
        await ct.sandbox.extractAndSendStudies(targetNode);
        const msgs = ct.calls.sendMessage.filter((m) => m.type === "new-studies");
        return msgs.length ? msgs[0].data.map((s) => s.id) : [];
    };

    assert.deepStrictEqual(await run({ reward: 10 }), ["usd12"], "$10 minimum keeps $12, drops $8 and skips £9");
    assert.deepStrictEqual(await run({ reward: 1 }), ["usd8", "usd12"], "any minimum skips pound rewards");
    assert.deepStrictEqual(await run({ rewardPerHour: 20 }), ["usd12"], "$20/h minimum keeps $24/h, skips £18/h");
    assert.deepStrictEqual(await run({}), ["usd8", "usd12", "gbp9"], "no minimum -> everything, including pounds");
});

test("4: ntfy network failure does not affect the browser notification", async () => {
    const before = unhandled.length;

    const rejecting = loadBackground({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, sync: BASE_SYNC });
    await rejecting.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
    await flush();
    assert.strictEqual(rejecting.calls.notifications.length, 1);
    assert.strictEqual(rejecting.fetchCalls.length, 1);

    const throwingSync = loadBackground({ fetchImpl: () => { throw new Error("sync boom"); }, sync: BASE_SYNC });
    await throwingSync.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
    await flush();
    assert.strictEqual(throwingSync.calls.notifications.length, 1);

    const http500 = loadBackground({ fetchImpl: async () => ({ ok: false, status: 500 }), sync: BASE_SYNC });
    await http500.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
    await flush();
    assert.strictEqual(http500.calls.notifications.length, 1);

    assert.strictEqual(unhandled.length, before, "no unhandled promise rejections");
});

test("4b: browser notification is created before the ntfy request is awaited", async () => {
    let notificationCountWhenFetchStarted = -1;
    const bg = loadBackground({
        fetchImpl: () => new Promise(() => {}), // never resolves
        sync: BASE_SYNC,
    });
    const origFetch = bg.sandbox.fetch;
    bg.sandbox.fetch = (url, init) => {
        notificationCountWhenFetchStarted = bg.calls.notifications.length;
        return origFetch(url, init);
    };
    await bg.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
    await flush();
    assert.strictEqual(notificationCountWhenFetchStarted, 1);
    assert.strictEqual(bg.calls.notifications.length, 1);
});

test("5: disabled forwarding / empty topic / invalid topic send nothing, notification unchanged", async () => {
    const variants = [
        { ntfyActive: false, ntfyTopic: "prolific-test-topic" },
        { ntfyActive: true, ntfyTopic: "" },
        { ntfyActive: true, ntfyTopic: "   " },
        { ntfyActive: true, ntfyTopic: "bad topic/with slash" },
        {},
    ];
    for (const v of variants) {
        const sync = Object.assign({}, BASE_SYNC);
        delete sync.ntfyActive;
        delete sync.ntfyTopic;
        Object.assign(sync, v);
        const bg = loadBackground({ fetchImpl: okFetch, sync });
        await bg.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
        await flush();
        assert.strictEqual(bg.fetchCalls.length, 0, `no ntfy request for ${JSON.stringify(v)}`);
        assert.strictEqual(bg.calls.notifications.length, 1);
        assert.strictEqual(bg.calls.notifications[0].opts.title, STUDY.title);
        assert.strictEqual(
            bg.calls.notifications[0].opts.message,
            "• Reward: $10.00\n• Reward per hour: $20.00\n• Time: 30 mins\n• By Example Lab"
        );
    }
});

test("5b: a bare sendNotification() without study data (title mode) is not forwarded", async () => {
    const bg = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    bg.sandbox.sendNotification();
    await flush();
    assert.strictEqual(bg.calls.notifications.length, 1);
    assert.strictEqual(bg.fetchCalls.length, 0);
});

test("6: popup Test button (play-sound) sends one test ntfy message when enabled, none when disabled", async () => {
    const enabled = loadBackground({ fetchImpl: okFetch, sync: BASE_SYNC });
    await enabled.dispatch({ target: "background", type: "play-sound" });
    await flush();
    assert.strictEqual(enabled.calls.notifications.length, 1, "browser test notification still shown");
    assert.strictEqual(enabled.fetchCalls.length, 1, "one ntfy test message");
    const req = enabled.fetchCalls[0];
    assert.strictEqual(req.url, "https://ntfy.sh/prolific-test-topic");
    assert.strictEqual(req.init.headers.Title, "Prolific");
    assert.strictEqual(req.init.headers.Click, "https://app.prolific.com/");
    assert.ok(req.init.body.includes("Test notification"));

    const disabled = loadBackground({ fetchImpl: okFetch, sync: Object.assign({}, BASE_SYNC, { ntfyActive: false }) });
    await disabled.dispatch({ target: "background", type: "play-sound" });
    await flush();
    assert.strictEqual(disabled.calls.notifications.length, 1);
    assert.strictEqual(disabled.fetchCalls.length, 0);
});

test("5c: 'show notification' off -> neither browser notification nor ntfy request", async () => {
    const bg = loadBackground({ fetchImpl: okFetch, sync: Object.assign({}, BASE_SYNC, { showNotification: false }) });
    await bg.dispatch({ target: "background", type: "new-studies", data: [STUDY] });
    await flush();
    assert.strictEqual(bg.calls.notifications.length, 0);
    assert.strictEqual(bg.fetchCalls.length, 0);
});

test("manifest: ntfy.sh host permission present, nothing else added", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    assert.deepStrictEqual(manifest.host_permissions, ["https://app.prolific.com/*", "https://ntfy.sh/*"]);
    assert.deepStrictEqual(manifest.permissions, ["storage", "notifications", "offscreen", "tabs"]);
});

// ---------- runner ----------
(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log("PASS  " + t.name);
        } catch (err) {
            failed++;
            console.log("FAIL  " + t.name);
            console.log((err && err.stack) || err);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
