import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeYouTubeUrl } from './youtube.mjs';

const id = 'rQJoEpzKkNk';
test('YouTube links normalize to one canonical direct video URL without tracking or playback parameters', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&autoplay=0&t=45#tracking`,
    `http://m.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=tracking`,
    `https://youtube.com/live/${id}?feature=share`, `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`, `  https://youtube.com/watch?v=${id}  `,
  ]) assert.deepEqual(normalizeYouTubeUrl(url), { videoId: id, url: `https://www.youtube.com/watch?v=${id}` });
});
test('YouTube normalization rejects arbitrary hosts, credentials, explicit ports, malformed IDs and channel links', () => {
  for (const url of [
    '', null, id, `javascript:alert(1)`, `data:text/html,${id}`, `file:///watch?v=${id}`,
    `https://youtube.com.attacker.invalid/watch?v=${id}`, `https://evil.youtube.com/watch?v=${id}`,
    `https://www.www.youtube.com/watch?v=${id}`, `https://youtube.com@attacker.invalid/watch?v=${id}`,
    `https://user:pass@youtube.com/watch?v=${id}`, `https://youtube.com:443/watch?v=${id}`,
    `https://youtube.com:80/watch?v=${id}`, `http://youtube.com:80/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&v=bad`, `https://youtube.com/watch?v=bad`,
    `https://youtube.com/watch?v=${id}%0A`, `https://youtube.com/watch?v=${id}/bad`,
    `https://youtu.be/${id}/extra`, `https://youtube.com/@channel/live`,
    `https://youtube.com/channel/UC123/live`, `https://youtube.com/playlist?list=${id}`,
    `https://youtube.com\\@attacker.invalid/watch?v=${id}`, `https://you\ntube.com/watch?v=${id}`,
  ]) assert.throws(() => normalizeYouTubeUrl(url), undefined, String(url));
});
