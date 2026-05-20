# DCR submit-success delight sounds

Drop the audio file here:

    dcr-complete-flush.mp3

Played at 0.25 volume after a confirmed DCR submission. See
`public/app.js` → `playDcrSuccessSound()` for the playback path. The
feature flag is `ENABLE_DCR_SUCCESS_SOUND` near the top of the file —
flip to `false` to disable without removing wiring.

Behavior:
- Plays once per submission (dedup by submission id)
- Never plays on validation errors or draft restore
- Silently no-ops when the file is missing or autoplay is blocked
- Decorative only — no screen-reader announcement, no DOM element
