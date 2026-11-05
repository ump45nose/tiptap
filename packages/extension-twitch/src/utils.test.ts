import { expect, it } from 'vite-plus/test'

import {
  getAttributesFromTwitchEmbedUrl,
  getEmbedUrlFromTwitchUrl,
  isValidTwitchUrl,
} from './utils.js'

it.each([
  'https://player.twitch.tv/?video=abc&parent=example.com',
  'https://player.twitch.tv/?channel=foo%2Fbar&parent=example.com',
  'https://clips.twitch.tv/embed?clip=bad%20clip&parent=example.com',
])('returns null for malformed embed identifiers: %s', embedUrl => {
  expect(getAttributesFromTwitchEmbedUrl(embedUrl)).toBeNull()
})

it.each([
  'https://www.twitch.tv/',
  'https://twitch.tv/',
  'https://www.twitch.tv/?filter=archives',
  'https://clips.twitch.tv/',
  'https://example.com/videos/123',
])('rejects bare or non-Twitch URLs that cannot embed: %s', url => {
  expect(isValidTwitchUrl(url)).toBeFalsy()
  expect(getEmbedUrlFromTwitchUrl({ url, parent: 'example.com' })).toBeNull()
})

it.each([
  'https://www.twitch.tv/videos/1234567890',
  'https://www.twitch.tv/examplechannel',
  'https://www.twitch.tv/examplechannel/clip/ExampleClipName-ABC123',
  'https://clips.twitch.tv/ExampleClipName',
])('accepts Twitch URLs that can embed: %s', url => {
  expect(isValidTwitchUrl(url)).toBeTruthy()
  expect(getEmbedUrlFromTwitchUrl({ url, parent: 'example.com' })).toBeTruthy()
})
