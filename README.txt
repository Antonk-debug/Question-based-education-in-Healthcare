Adaptive Quiz Studio

How to start on your computer:
1. Double-click "Start Adaptive Quiz Studio.bat".
2. Keep the backend window open.
3. The app opens at http://127.0.0.1:4173/.

If Gemini says the API key is invalid:
1. Create a new key in Google AI Studio.
2. Double-click "Update Gemini API Key.bat".
3. Paste the new key.
4. Close old backend windows.
5. Double-click "Start Adaptive Quiz Studio.bat" again.

The app uses gemini-3.1-flash-lite through the local backend.
If that model is temporarily unavailable or over quota, the backend automatically retries with gemini-3.5-flash, then gemini-2.5-flash, and then gemini-2.5-flash-lite.

How to share as a hosted app:
1. Upload this folder to a web host that can run Node, such as Render, Railway, Fly.io, Google Cloud Run, or another Node web service.
2. Set the start command to: npm start
3. Add these environment variables in the host dashboard:
   GEMINI_API_KEY = your Gemini API key
   ACCESS_CODE = an optional code users must enter
   GEMINI_MODEL = gemini-3.1-flash-lite
   GEMINI_MODELS = gemini-3.1-flash-lite,gemini-3.5-flash,gemini-2.5-flash,gemini-2.5-flash-lite
4. Do not upload your .env file publicly.

If ACCESS_CODE is empty, the app opens without a code.
If ACCESS_CODE has a value, users only need the website link and that code. They never see the Gemini API key.

See HOSTING.md for the shorter hosting checklist.
