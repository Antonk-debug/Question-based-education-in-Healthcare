# Hosting Adaptive Quiz Studio

This version is ready to run as a normal hosted web app. Users open one link, and your Gemini API key stays on the server.

## Environment variables

Set these in your hosting provider's dashboard:

```text
GEMINI_API_KEY=your-gemini-api-key
ACCESS_CODE=optional-code-users-enter
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_MODELS=gemini-3.1-flash-lite,gemini-3.5-flash,gemini-2.5-flash,gemini-2.5-flash-lite
```

If `ACCESS_CODE` is empty, the app opens without a code. If it has a value, users see a simple access-code screen.

Do not upload a real `.env` file to a public repo or hosting dashboard file browser. Use environment variables instead.

## Node hosting

Use these settings:

```text
Build command: npm install
Start command: npm start
```

The included `package.json` starts `server.js`, and the server automatically listens on the host and port provided by most hosting platforms.

## Render shortcut

The included `render.yaml` can be used as a Render blueprint. After creating the service, set `GEMINI_API_KEY` and optionally `ACCESS_CODE` in Render's environment settings.

## Local mode

Double-click `Start Adaptive Quiz Studio.bat` as before. Local mode still reads `.env`.
