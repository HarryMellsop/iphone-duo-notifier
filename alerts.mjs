// Sends an alert to every channel set up in the environment: Slack, Google Chat, text (Twilio) and email.
// No dependencies: fetch for the web APIs and a small SMTP client for email.
//
// An alert is a header { emoji, text } and a list of items { what, price, store, place, mi, reserve, page }.

import net from "node:net";
import tls from "node:tls";

const env = (k) => (process.env[k] || "").trim();
const list = (k) => env(k).split(",").map((s) => s.trim()).filter(Boolean);

// --- message text --------------------------------------------------------------------------------

// Slack and Google Chat share the same markup: *bold* and <url|label> links.
function chatText(h, items, mention = "") {
	return `${mention}${h.emoji} *${h.text}*\n` + items.map((i) => `• *${i.what}* ($${i.price}) at *${i.store}*, ${i.place} (${i.mi} mi) — <${i.reserve}|Reserve> · <${i.page}|Store page>`).join("\n");
}

export function plainText(h, items) {
	return `${h.emoji} ${h.text}\n\n` + items.map((i) => `${i.what} ($${i.price}) at ${i.store}, ${i.place} (${i.mi} mi)\nReserve: ${i.reserve}\nStore page: ${i.page}`).join("\n\n") + "\n";
}

// Twilio caps a message at 1600 characters; past that, say how many more there are.
function smsText(h, items) {
	let out = h.text;
	for (const [n, i] of items.entries()) {
		const next = `\n\n${i.what} $${i.price} at ${i.store} (${i.mi} mi)\n${i.reserve}`;
		if (out.length + next.length > 1570) return `${out}\n\n+${items.length - n} more`;
		out += next;
	}
	return out;
}

// --- channels ------------------------------------------------------------------------------------

async function post(url, body, headers = {}) {
	const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) });
	const text = await r.text();
	if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
	return text;
}

// Returns true when every key is set, false when none is, and throws when only some are.
function complete(what, keys) {
	const missing = keys.filter((k) => !env(k));
	if (missing.length === keys.length) return false;
	if (missing.length) throw new Error(`${what} alerts are half set up in .env: fill in ${missing.join(", ")}.`);
	return true;
}

function slack() {
	const webhook = env("SLACK_WEBHOOK_URL"), token = env("SLACK_BOT_TOKEN");
	if (!webhook && !token) return null;
	// Advanced: a bot token posts to SLACK_CHANNEL and also DMs SLACK_DM. SLACK_MENTION @-tags a user ID.
	const channels = [env("SLACK_CHANNEL") || "#duo-alerts", env("SLACK_DM")].filter(Boolean);
	const mention = env("SLACK_MENTION") ? `<@${env("SLACK_MENTION")}> ` : "";
	return async (h, items) => {
		const text = chatText(h, items, mention);
		if (!token) return void (await post(webhook, { text, unfurl_links: false }));
		const errors = [];
		for (const channel of channels) {
			const j = JSON.parse(await post("https://slack.com/api/chat.postMessage", { channel, text, unfurl_links: false }, { Authorization: `Bearer ${token}` }));
			if (!j.ok) errors.push(`${channel}: ${j.error}`);
		}
		if (errors.length) throw new Error(errors.join("; "));
	};
}

function googleChat() {
	const url = env("GOOGLE_CHAT_WEBHOOK_URL");
	return url ? async (h, items) => void (await post(url, { text: chatText(h, items) })) : null;
}

function text() {
	if (!complete("Text", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TEXT_TO"])) return null;
	const sid = env("TWILIO_ACCOUNT_SID");
	const auth = "Basic " + Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
	return async (h, items) => {
		const Body = smsText(h, items);
		for (const To of list("TEXT_TO")) {
			const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: "POST", headers: { Authorization: auth }, body: new URLSearchParams({ To, From: env("TWILIO_FROM"), Body }) });
			if (!r.ok) throw new Error(`to ${To}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
		}
	};
}

function email() {
	if (!complete("Email", ["EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_TO"])) return null;
	const host = env("SMTP_HOST") || "smtp.gmail.com", port = +(env("SMTP_PORT") || 465), user = env("EMAIL_USER");
	const pass = host === "smtp.gmail.com" ? env("EMAIL_PASSWORD").replace(/\s+/g, "") : env("EMAIL_PASSWORD"); // Google shows app passwords with spaces
	return (h, items) => smtpSend({ host, port, user, pass, from: env("EMAIL_FROM") || user, to: list("EMAIL_TO"), subject: `${h.emoji} ${h.text}`, text: plainText(h, items) });
}

// [name, send(header, items)] for each channel set up; throws if one is only partly set up.
export function channels() {
	return [["Slack", slack()], ["Google Chat", googleChat()], ["Text", text()], ["Email", email()]].filter(([, send]) => send);
}

// --- email ---------------------------------------------------------------------------------------

// RFC 2047 encoded words of at most 45 bytes each, so non-ASCII subjects survive every mail server.
function encodeHeader(s) {
	const parts = [""];
	for (const ch of s) {
		if (Buffer.byteLength(parts.at(-1) + ch) > 45) parts.push("");
		parts[parts.length - 1] += ch;
	}
	return parts.map((p) => `=?UTF-8?B?${Buffer.from(p).toString("base64")}?=`).join("\r\n ");
}

// Minimal SMTP client: implicit TLS on port 465, STARTTLS on any other port, then AUTH PLAIN.
async function smtpSend({ host, port, user, pass, from, to, subject, text }) {
	const message = [
		`From: iPhone Duo alerts <${from}>`,
		`To: ${to.join(", ")}`,
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@iphone-duo-alerts>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		Buffer.from(text).toString("base64").replace(/.{76}/g, "$&\r\n"),
	].join("\r\n");

	let buf = "", failure = null;
	const replies = [], waiters = [];
	const flush = () => {
		while (waiters.length && (replies.length || failure)) {
			const w = waiters.shift();
			replies.length ? w.resolve(replies.shift()) : w.reject(failure);
		}
	};
	const attach = (s) => {
		s.on("data", (d) => {
			buf += d.toString("latin1");
			// A reply is any "NNN-" continuation lines, then a final "NNN text" (or bare "NNN") line.
			for (let m; (m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3})(?:[ \r][^\n]*)?\n/)); buf = buf.slice(m[0].length)) replies.push({ code: +m[1], text: m[0].trim() });
			flush();
		});
		s.on("error", (e) => { failure = e; flush(); });
		s.on("close", () => { failure ||= new Error("connection closed"); flush(); });
		s.setTimeout(30000, () => s.destroy(new Error("timed out")));
		return s;
	};
	const secure = port === 465;
	let sock = attach(secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
	const step = async (cmd, ok, label = cmd.split(" ")[0]) => {
		if (cmd) sock.write(cmd + "\r\n");
		const r = await new Promise((resolve, reject) => { waiters.push({ resolve, reject }); flush(); });
		if (!ok.includes(r.code)) throw new Error(`${label} failed: ${r.text}`);
		return r;
	};
	try {
		await step("", [220], "connect");
		const hello = await step("EHLO localhost", [250]);
		if (!secure) {
			if (!/STARTTLS/i.test(hello.text)) throw new Error(`${host}:${port} doesn't offer STARTTLS; try SMTP_PORT=465`);
			await step("STARTTLS", [220]);
			sock.removeAllListeners("data");
			sock.setTimeout(0);
			sock = attach(tls.connect({ socket: sock, servername: host }));
			await step("EHLO localhost", [250]);
		}
		await step(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`, [235], "login");
		await step(`MAIL FROM:<${from}>`, [250]);
		for (const rcpt of to) await step(`RCPT TO:<${rcpt}>`, [250, 251]);
		await step("DATA", [354]);
		await step(`${message}\r\n.`, [250], "send");
		await step("QUIT", [221]).catch(() => {});
	} finally {
		sock.destroy();
	}
}
