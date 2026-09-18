import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { profilePhotoError, PROFILE_PHOTO_MAX_BYTES } from '../src/lib/profile-photo';
import { ProfilePhoto, ProfilePhotoEditor } from '../src/components/profile-photo';

test('profile photo accepts bounded raster files and refuses SVG, fake extensions and empty files', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp'])
    assert.equal(profilePhotoError({ type, size: PROFILE_PHOTO_MAX_BYTES }), null);
  for (const type of ['image/svg+xml', 'text/plain', 'image/gif', ''])
    assert.match(profilePhotoError({ type, size: 20 })!, /JPG/);
  for (const size of [0, PROFILE_PHOTO_MAX_BYTES + 1])
    assert.match(profilePhotoError({ type: 'image/jpeg', size })!, /5MB/);
});
test('photo has an accessible identity; unavailable accounts have a compact fallback', () => {
  const photo = renderToStaticMarkup(
    createElement(ProfilePhoto, { name: '보호자', url: '/api/profile/photo?v=version' }),
  );
  assert.match(photo, /보호자의 프로필 사진/);
  assert.match(photo, /\/api\/profile\/photo/);
  assert.match(renderToStaticMarkup(createElement(ProfilePhoto, { name: '보호자' })), /보<\/span>/);
});
test('photo editor explains privacy and gives separate change and remove actions', () => {
  const markup = renderToStaticMarkup(
    createElement(ProfilePhotoEditor, {
      name: '보호자',
      url: '/api/profile/photo?v=version',
      onSaved: async () => {},
    }),
  );
  assert.match(markup, /사진 바꾸기/);
  assert.match(markup, /사진 삭제/);
  assert.match(markup, /내 마이 화면에만/);
  assert.doesNotMatch(markup, /<form/);
});
