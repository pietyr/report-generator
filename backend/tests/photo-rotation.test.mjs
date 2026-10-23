import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { preparePhotoDerivatives, resolvePhotoVariant, removePhotoFiles } from '../dist/images.js'

test('quarter turns preserve source pixels, use separate caches and can be reset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photo-rotation-'))
  try {
    const source = path.join(dir, 'photo.png')
    const width = 6
    const height = 4
    const pixels = Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => i * 3 % 256))
    await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(source)
    const original = await readFile(source)
    for (const rotation of [90, 180, 270, 0, 90]) {
      const prepared = await preparePhotoDerivatives(source, 'photo.png', rotation)
      assert.equal(prepared.source, source)
      const { data, info } = await sharp(prepared.full).raw().toBuffer({ resolveWithObject: true })
      const swap = rotation === 90 || rotation === 270
      assert.equal(info.width, swap ? height : width)
      assert.equal(info.height, swap ? width : height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [rx, ry] = rotation === 90 ? [height - y - 1, x]
            : rotation === 180 ? [width - x - 1, height - y - 1]
            : rotation === 270 ? [y, width - x - 1] : [x, y]
          const offset = (ry * info.width + rx) * 3
          const originalOffset = (y * width + x) * 3
          assert.deepEqual(data.subarray(offset, offset + 3), pixels.subarray(originalOffset, originalOffset + 3))
        }
      }
      for (const size of ['thumb', 'preview', 'full']) {
        const resolved = await resolvePhotoVariant(source, 'photo.png', size, rotation)
        assert.equal(resolved.fullPath, source, 'DB path must keep pointing to the source')
        const metadata = await sharp(resolved.path).metadata()
        assert.equal(metadata.width, info.width)
        assert.equal(metadata.height, info.height)
      }
      assert.deepEqual(await readFile(source), original)
    }
    removePhotoFiles(source)
    assert.deepEqual(await readdir(dir), [], 'Deletion must remove every cached orientation')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manual rotation follows EXIF orientation and removes the orientation tag', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photo-exif-'))
  try {
    const source = path.join(dir, 'phone.jpg')
    await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(source)
    const original = await readFile(source)
    const upright = await preparePhotoDerivatives(source, 'phone.jpg', 0)
    assert.equal((await sharp(upright.preview).metadata()).width, 40)
    for (const [rotation, width, height] of [[90, 80, 40], [180, 40, 80], [270, 80, 40]]) {
      const prepared = await preparePhotoDerivatives(source, 'phone.jpg', rotation)
      const metadata = await sharp(prepared.full).metadata()
      assert.equal(metadata.width, width)
      assert.equal(metadata.height, height)
      assert.equal(metadata.orientation, undefined)
    }
    assert.deepEqual(await readFile(source), original)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
