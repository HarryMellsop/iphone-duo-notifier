# iPhone Duo stock alerts

Get a message the moment an iPhone Duo is in stock at an Apple Store near you, on **Slack**, **Google Chat**, **email** or **text**.

## Setup (about 5 minutes)

1. **Install Node.js** from [nodejs.org](https://nodejs.org): download it and run the installer.

2. **Download this project.** Click the green **Code** button at the top of this page, then **Download ZIP**, and unzip it.

3. **Open a terminal in the unzipped folder.**
   - **Mac:** open the **Terminal** app, type `cd ` (with a space after it), drag the folder onto the Terminal window, and press Enter.
   - **Windows:** open the folder, click the address bar at the top, type `cmd`, and press Enter.

4. **Run it:**

   ```
   node watch.mjs
   ```

   It asks for your ZIP code and how you want to be told, and walks you through each step. Then it sends you a test alert and starts watching.

**Leave that window open.** You get alerts while it's running and your computer is awake. Next time, open a terminal in the same folder and run `node watch.mjs` again. It remembers your answers.

## Good to know

- **Which way is quickest?** Slack or email (Gmail): about two minutes each. Google Chat only works with a work or school Google account. Text messages need a [Twilio](https://www.twilio.com) account and take the longest.
- **Work Slack won't let you add apps?** Pick email instead.
- **Change your answers:** `node watch.mjs --setup`
- **Send yourself another test alert:** `node watch.mjs --test`
- **Stop it:** press Ctrl+C in its window.
- **Run it in the background (Mac or Linux):** `bash start.sh` keeps it running and restarts it if it stops. It needs tmux (on a Mac: `brew install tmux`).

Your answers are saved in a file called `.env` in this folder. [.env.example](.env.example) lists every setting, if you'd rather edit it by hand.

## How it works

[In Stock Radar](https://instockradar.com/us/iphone-duo) tracks iPhone Duo stock at every US Apple Store. This script watches its live feed the same way an open browser tab does: it loads the page once, then keeps one live connection. When a model with your storage size or bigger turns up at a store within your radius, it alerts you with a link to reserve it on Apple's site. US stores only. Nothing to install apart from Node.js.
