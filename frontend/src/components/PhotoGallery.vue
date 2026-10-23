<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { api, type Category, type Photo, type Project } from '../api'

const props = defineProps<{
  project: Project
  photos: Photo[]
  disabled?: boolean
  cacheKey?: number
}>()
const emit = defineEmits<{
  'update:photos': [photos: Photo[]]
  busy: [busy: boolean]
  changed: []
}>()

const categories = ref<Category[]>([])
const dialog = ref<HTMLDialogElement | null>(null)
const selected = ref<Photo | null>(null)
const category = ref<number | null>(null)
const excluded = ref(false)
const rotation = ref(0)
const previewRotation = computed(() => rotation.value - (selected.value?.rotation || 0))
const partnerIds = ref<string[]>([])
const tierIds = ref<string[]>([])
const saving = ref(false)
const error = ref('')
const editError = ref('')
const notice = ref('')
const blocked = computed(() => props.disabled || saving.value)

async function loadCategories() {
  categories.value = await api.categories()
}

onMounted(async () => {
  try {
    await loadCategories()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

function categoryLabel(photo: Photo) {
  if (photo.excluded === 1) return 'Pominięte w raporcie'
  if (photo.category === null) return 'Bez tagu'
  return categories.value.find((c) => c.id === photo.category)?.label || `Kategoria ${photo.category}`
}

function assignments(photo: Photo) {
  return [
    ...props.project.tiers.filter((t) => photo.tierIds.includes(t.id)).map((t) => t.name),
    ...props.project.partners.filter((p) => photo.partnerIds.includes(p.id)).map((p) => p.name),
  ].join(', ') || 'Wszystkie raporty'
}

async function edit(photo: Photo) {
  if (blocked.value) return
  error.value = ''
  notice.value = ''
  editError.value = ''
  selected.value = photo
  rotation.value = photo.rotation
  category.value = photo.category
  excluded.value = photo.excluded === 1
  partnerIds.value = [...photo.partnerIds]
  tierIds.value = [...photo.tierIds]
  emit('busy', true)
  await nextTick()
  dialog.value?.showModal()
  if (!categories.value.length) {
    try {
      await loadCategories()
    } catch (e) {
      editError.value = e instanceof Error ? e.message : String(e)
    }
  }
}

function closeEditor() {
  if (saving.value) return
  dialog.value?.close()
  selected.value = null
  emit('busy', false)
}

async function save() {
  if (!selected.value || blocked.value) return
  if (!excluded.value && category.value === null &&
    (selected.value.category !== null || selected.value.excluded === 1)) {
    editError.value = 'Wybierz typ zdjęcia lub zaznacz pominięcie w raporcie.'
    return
  }
  saving.value = true
  editError.value = ''
  try {
    const updated = await api.tagPhoto(props.project.id, selected.value.id, {
      rotation: rotation.value,
      category: category.value,
      excluded: excluded.value,
      partnerIds: partnerIds.value,
      tierIds: tierIds.value,
    })
    emit('update:photos', props.photos.map((p) => p.id === updated.id ? updated : p))
    emit('changed')
    notice.value = `Zapisano zmiany zdjęcia „${updated.original_name}”.`
    saving.value = false
    closeEditor()
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function remove(photo: Photo) {
  if (blocked.value) return
  if (!confirm(`Usunąć zdjęcie „${photo.original_name}” z projektu? Nie będzie uwzględnione w kolejnych raportach. Tej operacji nie można cofnąć.`)) return
  saving.value = true
  emit('busy', true)
  error.value = ''
  notice.value = ''
  try {
    await api.deletePhoto(props.project.id, photo.id)
    emit('update:photos', props.photos.filter((p) => p.id !== photo.id))
    emit('changed')
    notice.value = `Usunięto zdjęcie „${photo.original_name}”.`
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
    emit('busy', false)
  }
}
</script>

<template>
  <section class="card stack" aria-label="Przegląd zdjęć">
    <h2>Przegląd zdjęć</h2>
    <p class="muted intro">Przed wygenerowaniem raportu możesz zmienić tagi, obrócić lub usunąć zdjęcia z projektu.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>
    <div v-if="photos.length" class="thumbs">
      <article v-for="photo in photos" :key="photo.id" class="thumb"
        :class="{ done: photo.category !== null, skipped: photo.excluded === 1 }">
        <img :src="`${api.photoUrl(project.id, photo.id, 'thumb', photo.rotation)}&t=${cacheKey || 0}`"
          :alt="photo.original_name" loading="lazy" decoding="async" />
        <div class="meta stack">
          <strong class="filename" :title="photo.original_name">{{ photo.original_name }}</strong>
          <span class="photo-tag">{{ categoryLabel(photo) }}</span>
          <span v-if="photo.excluded !== 1 && photo.category !== null" class="muted">{{ assignments(photo) }}</span>
          <div class="row actions">
            <button class="btn secondary" :disabled="blocked" :aria-label="`Zmień tag: ${photo.original_name}`" @click="edit(photo)">Zmień tag</button>
            <button class="btn secondary" :disabled="blocked" :aria-label="`Obróć: ${photo.original_name}`" @click="edit(photo)">Obróć</button>
            <button class="btn danger" :disabled="blocked" :aria-label="`Usuń: ${photo.original_name}`" @click="remove(photo)">Usuń</button>
          </div>
        </div>
      </article>
    </div>
    <p v-else class="muted">Brak zdjęć.</p>
  </section>

  <dialog ref="dialog" class="photo-dialog" aria-labelledby="photo-editor-title" @cancel.prevent="closeEditor">
    <form v-if="selected" class="stack" @submit.prevent="save">
      <h2 id="photo-editor-title">Edytuj zdjęcie</h2>
      <p class="filename">{{ selected.original_name }}</p>
      <div class="preview-stage">
        <img class="preview"
          :src="api.photoUrl(project.id, selected.id, 'preview', selected.rotation)"
          :alt="selected.original_name"
          :style="{ transform: `rotate(${previewRotation}deg)` }" />
      </div>
      <div class="row" aria-label="Obracanie zdjęcia">
        <button type="button" class="btn secondary" :disabled="blocked" @click="rotation = (rotation + 270) % 360">↶ Obróć w lewo</button>
        <button type="button" class="btn secondary" :disabled="blocked" @click="rotation = (rotation + 90) % 360">↷ Obróć w prawo</button>
        <span class="muted" role="status">Obrót: {{ rotation }}°</span>
      </div>
      <fieldset class="stack" :disabled="blocked">
        <label class="check"><input v-model="excluded" type="checkbox" /> Pomiń w raporcie</label>
        <label class="field">
          Typ zdjęcia
          <select v-model="category" :disabled="excluded">
            <option :value="null" disabled>Wybierz typ zdjęcia</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.id }}. {{ c.label }}</option>
          </select>
        </label>
        <fieldset class="stack assignments" :disabled="excluded">
          <legend>Stopnie partnerstwa (zbiorcze)</legend>
          <label v-for="tier in project.tiers" :key="tier.id" class="check">
            <input v-model="tierIds" type="checkbox" :value="tier.id" /> {{ tier.name }}
          </label>
          <strong>Firmy</strong>
          <label v-for="partner in project.partners" :key="partner.id" class="check">
            <input v-model="partnerIds" type="checkbox" :value="partner.id" /> {{ partner.name }}
          </label>
          <p class="muted intro">Bez wyboru = zdjęcie globalne (we wszystkich raportach).</p>
        </fieldset>
      </fieldset>
      <p v-if="editError" class="error" role="alert">{{ editError }}</p>
      <div class="row">
        <button type="button" class="btn secondary" :disabled="saving" @click="closeEditor">Anuluj</button>
        <button type="submit" class="btn accent" :disabled="blocked">{{ saving ? 'Zapisywanie…' : 'Zapisz zmiany' }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
h2, .intro, .filename { margin: 0; }
h2 { font-size: 1.2rem; }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 0.75rem; }
.thumb { border: 2px solid var(--line); border-radius: 10px; overflow: hidden; background: #faf8f5; display: flex; flex-direction: column; }
.thumb.done { border-color: var(--ok); }
.thumb.skipped { border-color: var(--muted); }
.thumb.skipped > img { opacity: 0.55; }
.thumb > img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #e8e4de; }
.meta { padding: 0.7rem; font-size: 0.85rem; flex: 1; gap: 0.5rem; overflow-wrap: anywhere; }
.filename { overflow-wrap: anywhere; }
.photo-tag { font-weight: 600; }
.actions { margin-top: auto; gap: 0.4rem; padding-top: 0.3rem; }
.actions .btn { padding: 0.4rem 0.65rem; font-size: 0.85rem; }
.photo-dialog { width: min(640px, calc(100% - 2rem)); max-height: 90vh; overflow: auto; border: 1px solid var(--line); border-radius: 14px; padding: 1.25rem; color: var(--ink); }
.photo-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.preview-stage { width: min(100%, 35vh); aspect-ratio: 1; margin: 0 auto; background: #111; border-radius: 10px; overflow: hidden; }
.preview { display: block; width: 100%; height: 100%; object-fit: contain; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
fieldset:disabled { opacity: 0.6; }
.assignments { border-top: 1px solid var(--line); padding-top: 0.5rem; }
legend { font-weight: 600; }
.check { display: flex; align-items: baseline; gap: 0.5rem; }
</style>
