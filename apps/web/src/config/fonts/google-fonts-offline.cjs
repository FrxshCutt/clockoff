/**
 * Offline build switch for `next/font/google`.
 *
 * `next build` downloads Inter from Google Fonts and fails when there is no network. Pointing Next's font
 * loader at this file answers every Google Fonts CSS request with an empty stylesheet, so the build succeeds
 * without any font download and the app renders with the system font stack declared in `app/layout.tsx`:
 *
 *   NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/src/config/fonts/google-fonts-offline.cjs" pnpm build
 *
 * Only use it for offline/air-gapped builds; normal builds should self-host Inter.
 */
const OFFLINE_STYLESHEET = "/* Work Mode offline build: Google Fonts skipped, using the system font stack. */";

module.exports = new Proxy(
  {},
  {
    get(_target, key) {
      return typeof key === "string" && key.startsWith("https://fonts.googleapis.com/") ? OFFLINE_STYLESHEET : undefined;
    },
  },
);
