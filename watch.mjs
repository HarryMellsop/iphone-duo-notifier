#!/usr/bin/env node
// Watches instockradar.com for iPhone Duo stock at Apple Stores near you and alerts you on Slack, Google
// Chat, text or email (alerts.mjs). The first run asks a few questions and saves the answers in .env
// (setup.mjs). Reads the site the same way an open browser tab does: one page load for the snapshot,
// then the /api/live WebSocket for diffs (ping every 30 s, same backoff as app.js). A reconnect re-loads
// the page once to resync, like a refresh would.
//
// Usage: node watch.mjs            set up on the first run, then watch
//        node watch.mjs --setup    answer the setup questions again
//        node watch.mjs --test     send a sample alert and exit

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { channels, plainText } from "./alerts.mjs";
import { lookupZip, setup } from "./setup.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fail = (msg) => { console.error(`\n${msg}\n`); process.exit(2); };

if (typeof WebSocket === "undefined") fail(`This needs Node.js 22 or newer, and you have ${process.version}. Get the latest at https://nodejs.org`);

// --- settings: .env next to this file; variables already in the environment win ------------------

const ENV_FILE = new URL("./.env", import.meta.url);
const fromFile = new Set();
function loadEnv() {
	if (!existsSync(ENV_FILE)) return;
	for (const raw of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
		const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
		if (!m || (m[1] in process.env && !fromFile.has(m[1]))) continue;
		process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
		fromFile.add(m[1]);
	}
}
function alertChannels() {
	try { return channels(); } catch (e) { fail(`${e.message} Or run: node watch.mjs --setup`); }
}

loadEnv();
let firstRun = false;
if (process.argv.includes("--setup") || (!existsSync(ENV_FILE) && !alertChannels().length)) {
	if (!process.stdin.isTTY) fail("Not set up yet. Run `node watch.mjs` in a terminal once to answer the setup questions.");
	await setup(ENV_FILE);
	for (const k of fromFile) delete process.env[k]; // drop the old answers before reading the new ones
	fromFile.clear();
	loadEnv();
	firstRun = true;
}
const CHANNELS = alertChannels();
if (!CHANNELS.length) fail("No way to alert you is set up yet. Run: node watch.mjs --setup");

const SITE = "https://instockradar.com";
const PAGE = `${SITE}/us/iphone-duo`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const CAP_ORDER = ["256gb", "512gb", "1tb", "2tb"];
const RADIUS_MI = +(process.env.RADIUS_MI || 25);
const MIN_CAP = (process.env.MIN_CAP || "256gb").trim().toLowerCase();
const NOTIFY_ON_START = process.env.NOTIFY_ON_START !== "0";
if (!(RADIUS_MI > 0)) fail("RADIUS_MI in .env should be a number of miles, like 25.");
if (!CAP_ORDER.includes(MIN_CAP)) fail(`MIN_CAP in .env should be one of ${CAP_ORDER.join(", ")}.`);

// Where "near you" is measured from: LAT and LNG if set, otherwise the ZIP code.
async function findHome() {
	const { LAT, LNG } = process.env;
	if (LAT && LNG) return { lat: +LAT, lng: +LNG, label: `${LAT}, ${LNG}` };
	const zip = (process.env.ZIP || "").trim();
	if (!zip) fail("Set ZIP in .env, or run: node watch.mjs --setup");
	let place;
	try { place = await lookupZip(zip); } catch (e) { fail(`Couldn't look up ZIP code ${zip} (${e.message}). Check your internet connection.`); }
	if (!place) fail(`ZIP=${zip} in .env isn't a US ZIP code.`);
	return { ...place, label: `${zip} (${place.name})` };
}

function miles(a, b) {
	const r = (d) => (d * Math.PI) / 180;
	const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
	return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// --- page snapshot -------------------------------------------------------------------------------

let HOME; // { lat, lng, label }
let D; // page-data from the last page load
let stores = new Map(); // id -> store within radius
let parts = new Map(); // part -> { cap, color, price }
let inStock = new Map(); // "store|part" -> since (unix s), watched stores/parts only

async function loadPage() {
	const r = await fetch(PAGE, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" } });
	if (!r.ok) throw new Error(`page HTTP ${r.status}`);
	const html = await r.text();
	const m = html.match(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/);
	if (!m) throw new Error("page-data not found");
	D = JSON.parse(m[1]);

	stores = new Map();
	for (const [id, name, city, lat, lng, slug] of D.stores) {
		const mi = miles(HOME, { lat, lng });
		if (mi <= RADIUS_MI) stores.set(id, { id, name, city, slug, mi });
	}
	const minIdx = CAP_ORDER.indexOf(MIN_CAP);
	const colorName = Object.fromEntries(D.cf.colors.map((c) => [c[0], c[1]]));
	const capName = Object.fromEntries(D.cf.caps.map((c) => [c[0], c[1]]));
	parts = new Map();
	for (const [part, [cap, color, price]] of Object.entries(D.cf.parts)) {
		if (CAP_ORDER.indexOf(cap) >= minIdx) parts.set(part, { cap: capName[cap] || cap, capSlug: cap, color: colorName[color] || color, colorSlug: color, price });
	}

	const next = new Map();
	for (const [st, s] of Object.entries(D.snap.stores || {})) {
		if (!stores.has(st)) continue;
		for (const [part, ts] of s.a || []) if (parts.has(part)) next.set(`${st}|${part}`, ts);
	}
	return next;
}

// --- store ZIP codes (from each store page's address data, cached in zips.json) ------------------

const ZIP_FILE = new URL("./zips.json", import.meta.url);
let zips = {};
try { zips = JSON.parse(readFileSync(ZIP_FILE, "utf8")); } catch (e) {}

async function loadZips(list) {
	const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
	let fetched = 0;
	for (const s of list) {
		if (zips[s.id]) continue;
		if (fetched++) await sleep(5000); // one store page every 5 s
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const r = await fetch(`${SITE}${D.storeBase}${s.slug}/iphone-duo`, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" } });
				if (r.status === 429) { await sleep(120000 * (attempt + 1)); continue; } // rate limited: back off 2, 4, 6... min
				const m = r.ok && (await r.text()).match(/"postalCode"\s*:\s*"(\d{5})/);
				if (m) { zips[s.id] = m[1]; writeFileSync(ZIP_FILE, JSON.stringify(zips, null, 1)); }
				else log(`no ZIP for ${s.name} (HTTP ${r.status})`);
			} catch (e) { log(`ZIP fetch failed for ${s.name}:`, e.message); }
			break;
		}
	}
}

// --- alerts --------------------------------------------------------------------------------------

function productUrl(part) {
	const p = parts.get(part);
	const col = p.color.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return `${D.apple}/shop/buy-iphone/iphone-duo/7.6-inch-display-${p.capSlug}-${col}-unlocked?purchaseOption=fullPrice&cppart=UNLOCKED%2FUS&acpart=none&skipul=1#part=${encodeURIComponent(part)}${D.cf.bag}`;
}

function item(key) {
	const [st, part] = key.split("|");
	const s = stores.get(st), p = parts.get(part);
	return { what: `${p.cap} ${p.color}`, price: p.price, store: s.name, place: `${s.city}${zips[st] ? ` ${zips[st]}` : ""}`, mi: s.mi.toFixed(1), reserve: productUrl(part), page: `${SITE}${D.storeBase}${s.slug}/iphone-duo` };
}

// Sends to every channel at once; true if all of them took it.
async function announce(keys, header) {
	if (!keys.length) return true;
	keys.sort((a, b) => stores.get(a.split("|")[0]).mi - stores.get(b.split("|")[0]).mi);
	const items = keys.map(item);
	log("ALERT " + plainText(header, items));
	const results = await Promise.allSettled(CHANNELS.map(([, send]) => send(header, items)));
	results.forEach((r, i) => log(`${CHANNELS[i][0]}: ${r.status === "fulfilled" ? "sent" : `FAILED: ${r.reason?.message}`}`));
	return results.every((r) => r.status === "fulfilled");
}

const IN_STOCK = { emoji: "📱", text: "iPhone Duo in stock near you!" };

// --- live socket (mirrors connect() in app.js) ---------------------------------------------------

let ws, retry = 0, heardAt = Date.now(), lastMsgAt = Date.now(), pingTimer;

function applyDiff(msg) {
	const fresh = [];
	for (const [st, part, av, ts, fam] of msg.ch || []) {
		if (fam && fam !== D.family) continue;
		if (!stores.has(st) || !parts.has(part)) continue;
		const key = `${st}|${part}`;
		if (av && !inStock.has(key)) { inStock.set(key, ts); fresh.push(key); }
		else if (!av && inStock.has(key)) { inStock.delete(key); log("sold out:", key); }
	}
	if (fresh.length) announce(fresh, IN_STOCK);
}

async function resync() {
	try {
		const next = await loadPage();
		const fresh = [...next.keys()].filter((k) => !inStock.has(k));
		inStock = next;
		if (fresh.length) announce(fresh, { ...IN_STOCK, text: `${IN_STOCK.text} (caught on resync)` });
	} catch (e) { log("resync failed:", e.message); }
}

function connect() {
	heardAt = Date.now(); // gives this attempt a full silence window before the watchdog abandons it
	const sock = (ws = new WebSocket(`wss://instockradar.com/api/live?cc=${D.cc}&f=${encodeURIComponent(D.family)}`));
	sock.onopen = () => { log("live socket open"); heardAt = Date.now(); if (retry > 0) resync(); retry = 0; };
	sock.onmessage = (e) => {
		if (e.data === "pong") return;
		heardAt = lastMsgAt = Date.now();
		try { applyDiff(JSON.parse(e.data)); } catch (err) { log("bad message", err.message); }
	};
	sock.onclose = (e) => {
		if (sock !== ws) return; // an abandoned socket (see watchdog) finally closing: already replaced
		retry++;
		const wait = Math.min(30000, 1500 * 2 ** Math.min(retry, 5));
		log(`live socket closed (${e.code}), reconnecting in ${wait / 1000}s`);
		setTimeout(connect, wait);
	};
	sock.onerror = () => {}; // onclose handles it
}

// --- main ----------------------------------------------------------------------------------------

HOME = await findHome();
inStock = await loadPage();
if (!stores.size) fail(`No Apple Stores within ${RADIUS_MI} miles of ${HOME.label}. Raise RADIUS_MI in .env.`);

if (firstRun || process.argv.includes("--test")) {
	// Closest store and the cheapest watched model, labelled as a test.
	const closest = [...stores.values()].sort((a, b) => a.mi - b.mi)[0];
	const part = [...parts.entries()].sort((a, b) => a[1].price - b[1].price)[0][0];
	await loadZips([closest]);
	console.log("\nSending you a test alert...");
	const ok = await announce([`${closest.id}|${part}`], { emoji: "🧪", text: "TEST ALERT (not real stock): your iPhone Duo alerts work. Real alerts look like this:" });
	if (!ok) fail("The test alert didn't go through (the reason is above). To fix your answers, run: node watch.mjs --setup");
	if (process.argv.includes("--test")) process.exit(0);
	console.log("\nTest alert sent. Check that you got it!\nNow watching for real stock. Leave this window open; press Ctrl+C to stop.\n");
}

loadZips([...stores.values()]); // background; alerts before it finishes just leave the ZIP out
log(`watching ${parts.size} models (${MIN_CAP} and up) at ${stores.size} Apple Stores within ${RADIUS_MI} mi of ${HOME.label}; ${inStock.size} in stock now. Alerts go to: ${CHANNELS.map(([n]) => n).join(", ")}`);
if (NOTIFY_ON_START && inStock.size) await announce([...inStock.keys()], { emoji: "📱", text: "Watcher started. Already in stock:" });
connect();
pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send("ping"); }, 30000);
// The server sends check updates every second or so, so a minute of silence means the socket is dead, whatever
// its readyState says. 2 Nov: a reconnect hung in CONNECTING for 8 h with no open, error or close event. Abandon
// the socket and start a new one; after 5 min with no message at all, exit and let run.sh start a fresh process.
setInterval(() => {
	const n = Date.now();
	if (n - lastMsgAt > 300000) { log("no live data for 5 min, exiting for a clean restart"); process.exit(1); }
	if (n - heardAt > 60000) {
		log(`socket silent (readyState ${ws?.readyState}), abandoning it and reconnecting`);
		const old = ws;
		retry++;
		connect(); // replaces ws first, so old's onclose is ignored
		try { old?.close(); } catch (e) {}
	}
}, 15000);
