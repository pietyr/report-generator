<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type PartnerImportTier, type Project } from '../api'

const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id as string)

const project = ref<Project | null>(null)
const error = ref('')
const tierName = ref('')
const partnerName = ref('')
const partnerTierId = ref('')
const importHtml = ref('')
const importError = ref('')
const importMessage = ref('')
const readingFile = ref(false)
const importing = ref(false)
const importBusy = computed(() => readingFile.value || importing.value)

async function load(projectId: string) {
  project.value = null
  partnerTierId.value = ''
  error.value = ''
  importHtml.value = ''
  clearImportFeedback()
  readingFile.value = false
  importing.value = false
  try {
    const loaded = await api.getProject(projectId)
    if (id.value !== projectId) return
    project.value = loaded
    partnerTierId.value = loaded.tiers[0]?.id ?? ''
  } catch (e) {
    if (id.value === projectId) error.value = e instanceof Error ? e.message : String(e)
  }
}

function clearImportFeedback() {
  importError.value = ''
  importMessage.value = ''
}

async function readHtmlFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  const projectId = id.value
  clearImportFeedback()
  readingFile.value = true
  try {
    const html = await file.text()
    if (id.value === projectId) importHtml.value = html
  } catch {
    if (id.value === projectId) importError.value = 'Nie udało się odczytać pliku HTML.'
  } finally {
    if (id.value === projectId) readingFile.value = false
  }
}

function readPartnerTiers(html: string) {
  const template = document.createElement('template')
  // Some copied Markdown escapes HTML tags and adds a backslash before line breaks.
  template.innerHTML = /\\<[a-z]/i.test(html)
    ? html.replace(/\\(?=<\/?[a-z]|\r?$)/gim, '')
    : html

  const tiers: PartnerImportTier[] = []
  let skipped = false
  for (const group of template.content.querySelectorAll('.partner-level')) {
    const heading = Array.from(group.querySelectorAll('h1, h2, h3, h4, h5, h6')).find(
      (element) => element.closest('.partner-level') === group,
    )
    const name = heading?.textContent?.trim()
    if (!name) {
      skipped = true
      continue
    }

    const partners: string[] = []
    for (const logo of group.querySelectorAll('img')) {
      if (logo.closest('.partner-level') !== group) continue
      const partner = logo.getAttribute('alt')?.trim()
      if (partner) partners.push(partner)
      else skipped = true
    }
    tiers.push({ name, partners })
  }

  return { tiers, skipped }
}

async function importPartners() {
  if (importBusy.value || !importHtml.value.trim()) return
  clearImportFeedback()
  const { tiers, skipped } = readPartnerTiers(importHtml.value)
  if (!tiers.length) {
    importError.value = 'W kodzie HTML nie znaleziono stopni partnerstwa. Sprawdź, czy grupy z klasą partner-level mają nagłówki.'
    return
  }

  const projectId = id.value
  importing.value = true
  try {
    const result = await api.importPartners(projectId, tiers)
    if (id.value !== projectId) return
    project.value = result.project
    if (!result.project.tiers.some((tier) => tier.id === partnerTierId.value)) {
      partnerTierId.value = result.project.tiers[0]?.id ?? ''
    }
    importMessage.value = result.addedTiers || result.addedPartners
      ? `Import zakończony. Dodane stopnie (${result.addedTiers}) i firmy (${result.addedPartners}) są na liście.`
      : 'Wszystkie rozpoznane stopnie i firmy są już na liście.'
    if (skipped) importMessage.value += ' Pominięto grupy bez nagłówka lub logotypy bez nazwy w atrybucie alt.'
  } catch (e) {
    if (id.value === projectId) importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (id.value === projectId) importing.value = false
  }
}

async function addTier() {
  if (!tierName.value.trim()) return
  project.value = await api.addTier(id.value, tierName.value.trim())
  tierName.value = ''
  if (!partnerTierId.value && project.value.tiers[0]) {
    partnerTierId.value = project.value.tiers[0].id
  }
}

async function renameTier(tierId: string, name: string) {
  project.value = await api.updateTier(id.value, tierId, { name })
}

async function removeTier(tierId: string) {
  if (!confirm('Usunąć stopień i firmy w nim?')) return
  project.value = await api.deleteTier(id.value, tierId)
}

async function moveTier(tierId: string, dir: -1 | 1) {
  if (!project.value) return
  const order = project.value.tiers.map((t) => t.id)
  const i = order.indexOf(tierId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return
  ;[order[i], order[j]] = [order[j], order[i]]
  project.value = await api.reorderTiers(id.value, order)
}

async function addPartner() {
  if (!partnerName.value.trim() || !partnerTierId.value) return
  project.value = await api.addPartner(
    id.value,
    partnerName.value.trim(),
    partnerTierId.value,
  )
  partnerName.value = ''
}

async function renamePartner(partnerId: string, name: string) {
  project.value = await api.updatePartner(id.value, partnerId, { name })
}

async function changePartnerTier(partnerId: string, tier_id: string) {
  project.value = await api.updatePartner(id.value, partnerId, { tier_id })
}

async function removePartner(partnerId: string) {
  if (!confirm('Usunąć firmę?')) return
  project.value = await api.deletePartner(id.value, partnerId)
}

function partnersInTier(tierId: string) {
  return project.value?.partners.filter((p) => p.tier_id === tierId) ?? []
}

watch(id, load, { immediate: true })
</script>

<template>
  <div v-if="project">
    <h1>Partnerzy</h1>
    <p class="subtitle">
      Stopnie od najwyższego (kolejność = ranking). Następnie firmy w stopniach.
    </p>

    <form class="card stack" @submit.prevent="importPartners">
      <h3 style="margin: 0">Import partnerów z HTML</h3>
      <p class="import-note muted">
        Wklej kod lub wybierz plik HTML. Import dopisze brakujące stopnie i firmy do projektu.
      </p>
      <label class="field">
        Kod HTML partnerów
        <textarea
          v-model="importHtml"
          rows="5"
          :disabled="importBusy"
          @input="clearImportFeedback"
        ></textarea>
      </label>
      <div class="row import-actions">
        <label class="field">
          Plik HTML
          <input
            type="file"
            accept=".html,.htm,text/html"
            :disabled="importBusy"
            @change="readHtmlFile"
          />
        </label>
        <button type="submit" class="btn accent" :disabled="importBusy || !importHtml.trim()">
          {{ importing ? 'Importowanie…' : 'Importuj partnerów' }}
        </button>
      </div>
      <p v-if="importError" class="error" role="alert">{{ importError }}</p>
      <p v-if="importMessage" class="ok import-note" role="status">{{ importMessage }}</p>
    </form>

    <fieldset class="card stack partner-card" aria-labelledby="partner-tiers-title" :disabled="importing">
      <h3 id="partner-tiers-title" style="margin: 0">Stopnie partnerstwa</h3>
      <div class="row">
        <input
          v-model="tierName"
          type="text"
          placeholder="np. Partner strategiczny"
          style="flex: 1"
          @keyup.enter="addTier"
        />
        <button class="btn accent" @click="addTier">Dodaj stopień</button>
      </div>
      <ul class="list">
        <li v-for="(t, idx) in project.tiers" :key="t.id">
          <div class="row" style="flex: 1">
            <span class="badge">{{ idx + 1 }}</span>
            <input
              :value="t.name"
              type="text"
              style="flex: 1"
              @change="renameTier(t.id, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="row">
            <button class="btn ghost" :disabled="idx === 0" @click="moveTier(t.id, -1)">↑</button>
            <button
              class="btn ghost"
              :disabled="idx === project.tiers.length - 1"
              @click="moveTier(t.id, 1)"
            >
              ↓
            </button>
            <button class="btn ghost" @click="removeTier(t.id)">Usuń</button>
          </div>
        </li>
      </ul>
      <p v-if="!project.tiers.length" class="muted">Dodaj przynajmniej jeden stopień.</p>
    </fieldset>

    <fieldset class="card stack partner-card" aria-labelledby="partner-companies-title" :disabled="importing">
      <h3 id="partner-companies-title" style="margin: 0">Firmy</h3>
      <div class="row">
        <select v-model="partnerTierId" style="min-width: 12rem" :disabled="!project.tiers.length">
          <option v-for="t in project.tiers" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <input
          v-model="partnerName"
          type="text"
          placeholder="Nazwa firmy"
          style="flex: 1"
          :disabled="!project.tiers.length"
          @keyup.enter="addPartner"
        />
        <button class="btn accent" :disabled="!project.tiers.length" @click="addPartner">
          Dodaj firmę
        </button>
      </div>

      <div v-for="t in project.tiers" :key="t.id" class="tier-block">
        <h4>{{ t.name }}</h4>
        <ul class="list">
          <li v-for="p in partnersInTier(t.id)" :key="p.id">
            <div class="row" style="flex: 1">
              <input
                :value="p.name"
                type="text"
                style="flex: 1"
                @change="renamePartner(p.id, ($event.target as HTMLInputElement).value)"
              />
              <select
                :value="p.tier_id"
                @change="changePartnerTier(p.id, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="tt in project.tiers" :key="tt.id" :value="tt.id">
                  {{ tt.name }}
                </option>
              </select>
            </div>
            <button class="btn ghost" @click="removePartner(p.id)">Usuń</button>
          </li>
        </ul>
        <p v-if="!partnersInTier(t.id).length" class="muted">Brak firm w tym stopniu.</p>
      </div>
    </fieldset>

    <div class="row" style="margin-top: 1rem">
      <button class="btn secondary" @click="router.push(`/projects/${id}`)">← Setup</button>
      <button class="btn secondary" @click="router.push(`/projects/${id}/photos`)">
        Dalej: zdjęcia →
      </button>
    </div>
  </div>
  <p v-else-if="error" class="error" role="alert">{{ error }}</p>
  <p v-else class="muted">Ładowanie…</p>
</template>

<style scoped>
.import-note {
  margin: 0;
}
.import-actions {
  align-items: flex-end;
}
.partner-card {
  margin: 1rem 0 0;
  min-inline-size: 0;
}
.tier-block {
  border-top: 1px solid var(--line);
  padding-top: 0.75rem;
}
.tier-block h4 {
  margin: 0 0 0.35rem;
  color: var(--accent);
}
</style>
