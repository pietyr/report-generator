<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type Photo, type Project } from '../api'
import PhotoGallery from '../components/PhotoGallery.vue'

const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id as string)

const project = ref<Project | null>(null)
const photos = ref<Photo[]>([])
const editingPhotos = ref(false)
const photosChanged = ref(false)
const tagged = computed(() => photos.value.filter((p) => p.category !== null || p.excluded === 1).length)
const independentlyTaggedTiers = computed(() => {
  if (!project.value) return []
  return project.value.tiers.filter(
    (tier) =>
      photos.value.some(
        (photo) =>
          photo.excluded !== 1 &&
          photo.category !== null &&
          photo.partnerIds.length === 0 &&
          photo.tierIds.includes(tier.id),
      ),
  )
})
const reportOptions = computed(() => [
  ...(project.value?.partners || []).map((partner) => ({
    id: `partner:${partner.id}`,
    name: partner.name,
    type: 'Firma',
  })),
  ...independentlyTaggedTiers.value.map((tier) => ({
    id: `tier:${tier.id}`,
    name: tier.name,
    type: 'Raport zbiorczy',
  })),
].sort((a, b) => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' })))
const reportOptionIds = computed(() => reportOptions.value.map((option) => option.id))
const selectedReportIds = ref<string[]>([])
const selectedReportCount = computed(() => selectedReportIds.value.length)
const error = ref('')
const generating = ref(false)
const done = ref(false)
const hasLatest = ref(false)
const latestUpdatedAt = ref<string | null>(null)
const progressDone = ref(0)
const progressTotal = ref(0)
const progressMessage = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

const progressPct = computed(() =>
  progressTotal.value
    ? Math.round((progressDone.value / progressTotal.value) * 100)
    : 0,
)

const generateButtonLabel = computed(() => {
  if (generating.value) return 'Generowanie…'
  if (hasLatest.value) return 'Wygeneruj ponownie'
  return 'Wygeneruj raporty'
})

async function loadLatest() {
  try {
    const latest = await api.latestGenerate(id.value)
    hasLatest.value = !!latest.exists
    latestUpdatedAt.value = latest.updatedAt || null
  } catch {
    hasLatest.value = false
    latestUpdatedAt.value = null
  }
}

async function load() {
  error.value = ''
  photosChanged.value = false
  editingPhotos.value = false
  try {
    const [loadedProject, loadedPhotos] = await Promise.all([
      api.getProject(id.value),
      api.listPhotos(id.value),
    ])
    project.value = loadedProject
    photos.value = loadedPhotos
    await loadLatest()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function selectAllReports() {
  selectedReportIds.value = [...reportOptionIds.value]
}

function clearReportSelection() {
  selectedReportIds.value = []
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function triggerDownload(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.value?.name || 'raporty'}.zip`
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadLatest() {
  error.value = ''
  try {
    const res = await fetch(api.latestGenerateDownloadUrl(id.value))
    if (!res.ok) throw new Error('Brak wygenerowanego ZIP')
    triggerDownload(await res.blob())
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function generate() {
  if (editingPhotos.value || generating.value) return
  if (selectedReportIds.value.length === 0) {
    error.value = 'Wybierz co najmniej jeden raport do wygenerowania.'
    return
  }
  generating.value = true
  error.value = ''
  done.value = false
  progressDone.value = 0
  progressTotal.value = 0
  progressMessage.value = 'Uruchamianie…'
  stopPoll()

  try {
    const started = await api.startGenerate(id.value, selectedReportIds.value)
    progressMessage.value = started.message
    progressDone.value = started.done
    progressTotal.value = started.total

    await new Promise<void>((resolve, reject) => {
      pollTimer = setInterval(async () => {
        try {
          const st = await api.generateStatus(id.value, started.jobId)
          progressDone.value = st.done
          progressTotal.value = st.total
          progressMessage.value = st.message
          if (st.status === 'done') {
            stopPoll()
            resolve()
          } else if (st.status === 'error') {
            stopPoll()
            reject(new Error(st.error || st.message || 'Błąd generowania'))
          }
        } catch (e) {
          stopPoll()
          reject(e)
        }
      }, 800)
    })

    const res = await fetch(api.generateDownloadUrl(id.value, started.jobId))
    if (!res.ok) throw new Error('Nie udało się pobrać ZIP')
    triggerDownload(await res.blob())
    done.value = true
    photosChanged.value = false
    progressMessage.value = 'ZIP pobrany'
    await loadLatest()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    stopPoll()
    generating.value = false
  }
}

const canGenerate = computed(
  () => !!project.value && selectedReportCount.value > 0,
)

onMounted(load)
watch(id, load)
watch(
  reportOptionIds,
  (currentIds, previousIds = []) => {
    const previouslyAvailable = new Set(previousIds)
    const selected = new Set(selectedReportIds.value)
    selectedReportIds.value = currentIds.filter(
      (recipientId) =>
        selected.has(recipientId) || !previouslyAvailable.has(recipientId),
    )
  },
)
onUnmounted(stopPoll)
</script>

<template>
  <div v-if="project">
    <h1>Generuj raporty</h1>
    <p class="subtitle">
      ZIP ze wszystkimi raportami (PPTX + PDF). Obejmuje firmy oraz stopnie oznaczone
      na zdjęciach bez wskazania konkretnej firmy.
    </p>

    <div class="card stack">
      <ul class="checklist">
        <li :class="{ ok: true }">
          Szablon / tło:
          {{ project.background_path ? 'OK (tło z szablonu)' : 'brak — białe tło (OK)' }}
        </li>
        <li :class="{ ok: reportOptions.length > 0 }">
          Dostępne raporty: {{ reportOptions.length }}
          <span v-if="independentlyTaggedTiers.length">
            (w tym dla samych stopni: {{ independentlyTaggedTiers.map((tier) => tier.name).join(', ') }})
          </span>
        </li>
        <li :class="{ ok: tagged > 0 }">
          Otagowane zdjęcia: {{ tagged }} / {{ photos.length }}
        </li>
        <li :class="{ ok: !!project.event_url }">
          URL wydarzenia: {{ project.event_url || 'pusty' }}
        </li>
        <li :class="{ ok: hasLatest }">
          Ostatni ZIP:
          <template v-if="hasLatest">
            dostępny
            <span v-if="latestUpdatedAt">
              ({{ new Date(latestUpdatedAt).toLocaleString('pl-PL') }})
            </span>
          </template>
          <template v-else>jeszcze nie wygenerowany</template>
        </li>
      </ul>

      <section class="report-picker stack" aria-labelledby="report-picker-title">
        <div class="row picker-head">
          <div>
            <strong id="report-picker-title">Wybierz raporty do wygenerowania</strong>
            <p class="muted picker-summary">
              Zaznaczono: {{ selectedReportCount }} / {{ reportOptions.length }}
            </p>
          </div>
          <div class="row">
            <button type="button" class="btn ghost" :disabled="generating" @click="selectAllReports">
              Zaznacz wszystkie
            </button>
            <button type="button" class="btn ghost" :disabled="generating" @click="clearReportSelection">
              Wyczyść
            </button>
          </div>
        </div>
        <div class="report-options">
          <label v-for="option in reportOptions" :key="option.id" class="report-option">
            <input v-model="selectedReportIds" type="checkbox" :value="option.id" :disabled="generating" />
            <span>{{ option.name }}</span>
            <span class="badge">{{ option.type }}</span>
          </label>
        </div>
      </section>

      <div v-if="generating || progressMessage" class="progress-block">
        <div class="progress-meta">
          <span>{{ progressMessage || 'Generowanie…' }}</span>
          <span v-if="progressTotal">{{ progressDone }}/{{ progressTotal }} ({{ progressPct }}%)</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: `${progressPct}%` }" />
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="done" class="ok">Pobieranie rozpoczęte.</p>
      <p v-if="photosChanged && hasLatest" class="muted" role="status">
        Zdjęcia zostały zmienione. Wygeneruj raporty ponownie, aby uwzględnić zmiany w ZIP.
      </p>

      <div class="row">
        <button class="btn secondary" @click="router.push(`/projects/${id}/tagging`)">
          ← Tagowanie
        </button>
        <button
          v-if="hasLatest"
          class="btn secondary"
          :disabled="generating"
          @click="downloadLatest"
        >
          Pobierz ostatni ZIP
        </button>
        <button
          class="btn accent"
          :disabled="!canGenerate || generating || editingPhotos"
          @click="generate"
        >
          {{ generateButtonLabel }}
        </button>
      </div>
    </div>

    <PhotoGallery
      :key="id"
      v-model:photos="photos"
      :project="project"
      :disabled="generating"
      @busy="editingPhotos = $event"
      @changed="photosChanged = true; done = false"
    />
  </div>
  <p v-else-if="error" class="error" role="alert">{{ error }}</p>
  <p v-else class="muted">Ładowanie…</p>
</template>

<style scoped>
.checklist {
  margin: 0;
  padding-left: 1.2rem;
}
.checklist li {
  margin: 0.35rem 0;
  color: var(--muted);
}
.checklist li.ok {
  color: var(--ok);
}
.report-picker {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #faf8f5;
}
.picker-head {
  justify-content: space-between;
}
.picker-summary {
  margin: 0.2rem 0 0;
}
.report-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 0.5rem;
}
.report-option {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: white;
}
.report-option > span:not(.badge) {
  flex: 1;
}
.report-option .badge {
  font-size: 0.72rem;
}
.progress-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.9rem;
  color: var(--muted);
}
.progress-bar {
  height: 10px;
  border-radius: 999px;
  background: #e8e2da;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}
</style>
