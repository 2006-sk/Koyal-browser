import assert from 'node:assert/strict';
import test from 'node:test';
import { inferUploadKind } from './shared.js';

test('upload inference distinguishes reference video from incidental image validation copy', () => {
  assert.equal(
    inferUploadKind(
      'Upload reference video',
      'The previous PNG was rejected; please select a valid video file for reference motion',
    ),
    'video',
  );
});

test('upload inference keeps character images and audio in their own media classes', () => {
  assert.equal(inferUploadKind('Choose files', 'Upload the provided character image'), 'image');
  assert.equal(inferUploadKind('Choose files', 'Upload narration audio'), 'audio');
});
