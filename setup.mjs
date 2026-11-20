// First-run questions: where you are and how to alert you. Writes the answers to .env.

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

// { lat, lng, name } for a US ZIP code, or null if there is no such ZIP.
export async function lookupZip(zip) {
	if (!/^\d{5}$/.test(zip)) return null;
	const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const p = (await r.json()).places[0];
	return { lat: +p.latitude, lng: +p.longitude, name: `${p["place name"]}, ${p["state abbreviation"]}` };
}

const CAPS = ["256gb", "512gb", "1tb", "2tb"];
function cap(v) {
	let c = v.toLowerCase().replace(/\s+/g, "");
	if (/^(256|512)$/.test(c)) c += "gb";
	if (/^[12]$/.test(c)) c += "tb";
	return CAPS.includes(c) ? c : null;
}

function phone(v) {
	const d = v.replace(/[\s().-]/g, "");
	const n = /^\d{10}$/.test(d) ? `+1${d}` : /^1\d{10}$/.test(d) ? `+${d}` : d;
	return /^\+\d{8,15}$/.test(n) ? n : null;
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const METHODS = {
	Slack: {
		label: "Slack",
		intro: `
Slack, in 4 steps:
  1. Open https://api.slack.com/apps?new_app=1 and choose "From scratch".
  2. Name it "iPhone Duo alerts", pick your workspace, and click "Create App".
  3. In the menu on the left click "Incoming Webhooks" and switch it On. Then click
     "Add New Webhook" at the bottom, pick the channel for alerts, and click "Allow".
  4. Copy the webhook URL it shows you.
  (If your work Slack won't let you add apps, press Ctrl+C, run this again and pick Email.)
`,
		ask: async (ask) => ({
			SLACK_WEBHOOK_URL: await ask("Paste the webhook URL", "", (v) => (v.startsWith("https://hooks.slack.com/") ? null : "That should start with https://hooks.slack.com/")),
		}),
	},
	"Google Chat": {
		label: "Google Chat (work or school Google accounts)",
		intro: `
Google Chat, in 3 steps:
  1. In Google Chat, open the space you want alerts in (or make a new space just for you).
  2. Click the space's name at the top, then "Apps & integrations", then "Add webhooks".
  3. Name it "iPhone Duo alerts", click "Save", and copy the webhook's link.
`,
		ask: async (ask) => ({
			GOOGLE_CHAT_WEBHOOK_URL: await ask("Paste the webhook link", "", (v) => (v.startsWith("https://chat.googleapis.com/") ? null : "That should start with https://chat.googleapis.com/")),
		}),
	},
	Email: {
		label: "Email (Gmail)",
		intro: `
Email through Gmail, in 2 steps:
  1. Make sure 2-Step Verification is on: https://myaccount.google.com/signinoptions/twosv
  2. Make an app password at https://myaccount.google.com/apppasswords
     (call it "iPhone Duo") and copy the 16 letters it shows you.
  (Not Gmail? Answer these, then set SMTP_HOST and SMTP_PORT in .env. See .env.example.)
`,
		ask: async (ask) => {
			const user = await ask("Your Gmail address", "", (v) => (isEmail(v) ? null : "That doesn't look like an email address."));
			const pass = await ask("The 16-letter app password", "", (v) => (/^[a-z]{16}$/i.test(v.replace(/\s+/g, "")) ? null : "App passwords are 16 letters, like: abcd efgh ijkl mnop"));
			const to = await ask("Send the alerts to", user, (v) => (v.split(",").every((e) => isEmail(e.trim())) ? null : "Enter an email address (or several, separated by commas)."));
			return { EMAIL_USER: user, EMAIL_PASSWORD: pass.replace(/\s+/g, ""), EMAIL_TO: to };
		},
	},
	Text: {
		label: "Text message (needs a Twilio account)",
		intro: `
Texts go through Twilio, a text-message service with free trial credit:
  1. Sign up at https://www.twilio.com/try-twilio
  2. Get a phone number: in the Twilio Console, Phone Numbers > Manage > Buy a number.
  3. Copy the Account SID and Auth Token from the Console's home page.
  On a free trial, Twilio only texts the number you signed up with. Twilio may also ask
  you to verify or register before texts to US numbers go through; follow its prompts.
`,
		ask: async (ask) => ({
			TWILIO_ACCOUNT_SID: await ask("Account SID", "", (v) => (/^AC[0-9a-f]{32}$/i.test(v) ? null : "It starts with AC and is 34 characters long.")),
			TWILIO_AUTH_TOKEN: await ask("Auth Token", "", (v) => (/^[0-9a-f]{32}$/i.test(v) ? null : "It's 32 letters and numbers.")),
			TWILIO_FROM: phone(await ask("Your Twilio phone number", "", (v) => (phone(v) ? null : "Enter it like +12125551234"))),
			TEXT_TO: phone(await ask("Your mobile number", "", (v) => (phone(v) ? null : "Enter it like +12125551234"))),
		}),
	},
};

// Asks the questions and writes the answers to `file` (replacing it).
export async function setup(file) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	rl.on("SIGINT", () => { console.log(); process.exit(130); });
	// Asks until `problem(answer)` returns nothing; an empty answer takes the default.
	async function ask(q, def = "", problem = () => null) {
		for (;;) {
			const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
			const p = await problem(a);
			if (!p) return a;
			console.log(`  ${p}`);
		}
	}
	try {
		console.log("\niPhone Duo stock alerts: setup (press Enter to take the answer in [brackets])\n");
		const vars = {};
		vars.ZIP = await ask("Your ZIP code", "", async (v) => {
			try {
				const place = await lookupZip(v);
				if (!place) return "Enter a 5-digit US ZIP code.";
				console.log(`  ${place.name}`);
			} catch (e) {
				return `Couldn't look that up (${e.message}). Check your internet connection and try again.`;
			}
		});
		vars.RADIUS_MI = await ask("Alert me about Apple Stores within how many miles", "25", (v) => (+v > 0 ? null : "Enter a number of miles, like 25."));
		vars.MIN_CAP = cap(await ask("Smallest storage you'd buy (256gb, 512gb, 1tb or 2tb)", "256gb", (v) => (cap(v) ? null : "Pick 256gb, 512gb, 1tb or 2tb.")));

		const names = Object.keys(METHODS), chosen = [];
		for (;;) {
			const left = names.filter((n) => !chosen.includes(n));
			console.log(chosen.length ? "\nAdd which one?" : "\nHow should it tell you?");
			left.forEach((n, i) => console.log(`  ${i + 1}) ${METHODS[n].label}`));
			const name = left[+(await ask(`Pick 1-${left.length}`, "", (v) => (left[+v - 1] ? null : `Type a number from 1 to ${left.length}.`))) - 1];
			console.log(METHODS[name].intro);
			Object.assign(vars, await METHODS[name].ask(ask));
			chosen.push(name);
			if (chosen.length === names.length) break;
			const more = await ask("\nAlso alert you another way? (y/n)", "n", (v) => (/^[yn]/i.test(v) ? null : "Type y or n."));
			if (/^n/i.test(more)) break;
		}

		const lines = ["# Your iPhone Duo alert settings, from `node watch.mjs --setup`. Every option is in .env.example.", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)];
		writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
		console.log("\nSaved your answers in the file .env in this folder.");
	} finally {
		rl.close();
	}
}
