import { describe, expect, it } from 'vitest'
import { describeMediaInfo, isDolbyAudioCodec } from './playback.js'

describe('describeMediaInfo', () => {
  it('flags audio-only streams as radio', () => {
    expect(describeMediaInfo({ audioCodec: 'mp4a.40.2' })).toStrictEqual({
      codecNote: 'Radio · mp4a.40.2',
      audioOnly: true
    })
  })

  it('a video stream without audio says so honestly', () => {
    expect(describeMediaInfo({ videoCodec: 'avc1.42E01E' })).toStrictEqual({
      codecNote: 'avc1.42E01E · no audio track',
      audioOnly: false
    })
  })

  it('notes when the server fixed Dolby to AAC', () => {
    expect(describeMediaInfo({ videoCodec: 'hev1.1.6.L93.B0', audioCodec: 'ac-3' }).codecNote).toBe(
      'hev1.1.6.L93.B0 + ac-3 — Dolby fixed to AAC by the server'
    )
  })

  it('a normal playable pair passes through untouched', () => {
    expect(describeMediaInfo({ videoCodec: 'avc1.100.31', audioCodec: 'mp4a.40.2' })).toStrictEqual({
      codecNote: 'avc1.100.31 + mp4a.40.2',
      audioOnly: false
    })
  })

  it('MEDIA_INFO with neither codec is not radio', () => {
    expect(describeMediaInfo({})).toStrictEqual({ codecNote: 'unknown codecs · no audio track', audioOnly: false })
  })
})

describe('isDolbyAudioCodec', () => {
  it('matches AC-3 and E-AC-3 spellings but not lookalikes', () => {
    expect(isDolbyAudioCodec('ac-3')).toBe(true)
    expect(isDolbyAudioCodec('AC3')).toBe(true)
    expect(isDolbyAudioCodec('eac3')).toBe(true)
    expect(isDolbyAudioCodec('Dolby Digital')).toBe(true)
    expect(isDolbyAudioCodec('mp4a.40.2')).toBe(false)
    expect(isDolbyAudioCodec('')).toBe(false)
    expect(isDolbyAudioCodec(undefined)).toBe(false)
  })
})
