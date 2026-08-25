'use strict';

const CFS_SLOTS = ['T1A', 'T1B', 'T1C', 'T1D'];

/** External spool holder id used in `currentJob.filamentSlot` when not on CFS */
const EXTERNAL_RACK_SLOT = 'rack';

/**
 * Creality `material_type` catalog ids (last 5 digits; leading brand digit stripped).
 * Only entries confirmed against SPARKX i7 / community box dumps — unknown codes stay empty.
 */
const MATERIAL_TYPE_BY_ID = {
	'00001': 'PLA',
	'00003': 'PETG',
	'00005': 'TPU',
};

/** Creality selfTestStep → label (known values only; others stay numeric) */
const SELF_TEST_STEP_LABELS = {
	5: 'leveling',
};

/** ioBroker `common.states` for selfTestStep */
const SELF_TEST_STEP_STATES = {
	0: 'idle',
	...SELF_TEST_STEP_LABELS,
};

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnreachableError(err) {
	const msg = err && err.message ? String(err.message) : String(err || '');
	return /EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|Timeout|ENOTFOUND|ECONNRESET/i.test(msg);
}

/**
 * @param {number} sec
 * @returns {string}
 */
function formatHms(sec) {
	if (!Number.isFinite(sec) || sec < 0) {
		sec = 0;
	}
	sec = Math.round(sec);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return [String(h).padStart(2, '0'), String(m).padStart(2, '0'), String(s).padStart(2, '0')].join(':');
}

/**
 * @param {number} remainingSec
 * @returns {string}
 */
function formatFinishAt(remainingSec) {
	if (!Number.isFinite(remainingSec) || remainingSec <= 0) {
		return '';
	}
	const end = new Date(Date.now() + remainingSec * 1000);
	const y = end.getFullYear();
	const m = String(end.getMonth() + 1).padStart(2, '0');
	const d = String(end.getDate()).padStart(2, '0');
	const hh = String(end.getHours()).padStart(2, '0');
	const mm = String(end.getMinutes()).padStart(2, '0');
	return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * @param {string} filename
 * @returns {string}
 */
function rawName(filename) {
	if (!filename) {
		return '';
	}
	return filename.split('/').pop() || '';
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeColor(raw) {
	if (raw == null || raw === '' || raw === '-1' || raw === 'None') {
		return '';
	}
	let c = String(raw).replace(/^#/, '');
	if (c.length === 7 && c.startsWith('0')) {
		c = c.slice(1);
	}
	if (c.length === 6) {
		return `#${c.toUpperCase()}`;
	}
	return c ? `#${c}` : '';
}

/**
 * @param {unknown} n
 * @returns {number|null}
 */
function round1(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) {
		return null;
	}
	return Math.round(v * 10) / 10;
}

/**
 * Normalize output_pin / fan values to the Creality/Klipper 0–255 PWM scale.
 * Moonraker usually reports 0–1 when `scale: 255` is set.
 *
 * @param {unknown} val
 * @returns {number}
 */
function pinToPwmScale(val) {
	const v = Number(val);
	if (!Number.isFinite(v) || v <= 0) {
		return 0;
	}
	if (v <= 1) {
		return v * 255;
	}
	return v;
}

/**
 * PWM duty as percent of full scale (0–100).
 *
 * @param {unknown} val
 * @returns {number}
 */
function pinToPercent(val) {
	const pwm = pinToPwmScale(val);
	if (pwm <= 0) {
		return 0;
	}
	return Math.round((pwm / 255) * 1000) / 10;
}

/**
 * Invert Creality M106 mapping: logical S (0–255) → pin = fanMin + (255-fanMin)/255 * S.
 * Returns the UI / slicer percentage that matches the printer display.
 *
 * @param {unknown} val Moonraker pin value (0–1 or 0–255)
 * @param {unknown} fanMin Creality `fan0_min` / `fan2_min` (0–254); 0 = no remapping
 * @returns {number}
 */
function pinToUiPercent(val, fanMin) {
	const pwm = pinToPwmScale(val);
	if (pwm <= 0) {
		return 0;
	}
	let min = Number(fanMin);
	if (!Number.isFinite(min) || min < 0 || min >= 255) {
		min = 0;
	}
	if (min === 0) {
		return pinToPercent(val);
	}
	const s = ((pwm - min) * 255) / (255 - min);
	const pct = (Math.max(0, Math.min(255, s)) / 255) * 100;
	return Math.round(pct * 10) / 10;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function resolveMaterialName(raw) {
	if (raw == null || raw === '' || raw === '-1' || raw === 'None') {
		return '';
	}
	const code = String(raw).trim();
	if (!code) {
		return '';
	}
	// Already a human label (e.g. from same_material)
	if (!/^\d+$/.test(code)) {
		return code;
	}
	if (MATERIAL_TYPE_BY_ID[code]) {
		return MATERIAL_TYPE_BY_ID[code];
	}
	// Brand digit + 5-digit catalog id (e.g. 000001 → 00001)
	if (code.length >= 6) {
		const catalogId = code.slice(-5);
		if (MATERIAL_TYPE_BY_ID[catalogId]) {
			return MATERIAL_TYPE_BY_ID[catalogId];
		}
	}
	return '';
}

/**
 * @param {Record<string, any>|null|undefined} box
 * @returns {Record<string, {material: string, color: string}>}
 */
function materialLookup(box) {
	const map = {};
	if (!box || !Array.isArray(box.same_material)) {
		return map;
	}
	for (const row of box.same_material) {
		const color = normalizeColor(row[1]);
		const material = resolveMaterialName(row[3]) || String(row[3] || '');
		for (const s of row[2] || []) {
			map[String(s).toUpperCase()] = { material, color };
		}
	}
	return map;
}

/**
 * External / side spool holder is active when filament flag is set and material/color present.
 *
 * @param {Record<string, any>|null|undefined} rack
 * @returns {boolean}
 */
function isExternalRackActive(rack) {
	if (!rack || typeof rack !== 'object') {
		return false;
	}
	const flag = rack.filament;
	if (flag == null || flag === '' || flag === 'None' || flag === '-1' || flag === '0' || flag === 0) {
		return false;
	}
	const hasColor = normalizeColor(rack.color_value);
	const hasMaterial = resolveMaterialName(rack.material_type);
	return !!(hasColor || hasMaterial || flag === '1' || flag === 1);
}

/**
 * @param {Record<string, any>|null|undefined} box
 * @param {Record<string, any>|null|undefined} inv
 * @returns {string}
 */
function resolveActiveSlot(box, inv) {
	const tnn = inv && inv.active_tnn ? String(inv.active_tnn).toUpperCase() : '';
	if (/^T\d[A-D]$/.test(tnn)) {
		return tnn;
	}
	if (box && box.filament && box[`T${box.filament}`]) {
		const letter = String(box[`T${box.filament}`].filament || '').toUpperCase();
		if (/^[A-D]$/.test(letter)) {
			return `T${box.filament}${letter}`;
		}
	}
	return '';
}

/**
 * @param {Record<string, any>|null|undefined} box
 * @param {Record<string, any>|null|undefined} inv
 * @param {Record<string, any>|null|undefined} [rack] Moonraker `filament_rack` (external spool)
 */
function parseCfs(box, inv, rack) {
	const matMap = materialLookup(box);
	let activeSlot = resolveActiveSlot(box, inv);
	const t1 = (box && box.T1) || {};
	const slots = {};

	for (let i = 0; i < 4; i++) {
		const id = CFS_SLOTS[i];
		const colorRaw = Array.isArray(t1.color_value) ? t1.color_value[i] : null;
		const typeRaw = Array.isArray(t1.material_type) ? t1.material_type[i] : null;
		const fromMap = matMap[id] || {};
		const color = normalizeColor(colorRaw) || fromMap.color || '';
		const material = fromMap.material || resolveMaterialName(typeRaw) || '';
		const occupied = !!(color || material);
		slots[id] = {
			color,
			material,
			occupied,
			active: id === activeSlot,
		};
	}

	let activeColor = '';
	let activeMaterial = '';

	if (activeSlot && slots[activeSlot]) {
		activeColor = slots[activeSlot].color || '';
		activeMaterial = slots[activeSlot].material || '';
	} else if (isExternalRackActive(rack)) {
		activeSlot = EXTERNAL_RACK_SLOT;
		activeColor = normalizeColor(rack.color_value);
		activeMaterial = resolveMaterialName(rack.material_type);
	}

	return {
		type: (box && box.type) || '',
		state: (box && box.state) || '',
		enable: !!(box && box.enable),
		temperature: t1.temperature != null && t1.temperature !== 'None' ? Number(t1.temperature) : null,
		humidity: t1.dry_and_humidity != null && t1.dry_and_humidity !== 'None' ? Number(t1.dry_and_humidity) : null,
		activeSlot,
		activeColor,
		activeMaterial,
		slots,
	};
}

/**
 * @param {string} klipperState
 * @param {Record<string, any>} ct
 * @returns {string}
 */
function mapUiState(klipperState, ct) {
	ct = ct || {};
	const errCode = ct.err && ct.err.errcode != null ? Number(ct.err.errcode) : 0;
	if (errCode !== 0) {
		return 'error';
	}

	const withSelf = Number(ct.withSelfTest) || 0;
	if (withSelf >= 1 && withSelf <= 99) {
		const step = Number(ct.selfTestStep);
		return SELF_TEST_STEP_LABELS[step] || 'self-testing';
	}

	const st = ct.state != null ? Number(ct.state) : NaN;
	const fname = ct.printFileName ? String(ct.printFileName) : '';
	let progress = Number(ct.printProgress != null ? ct.printProgress : ct.dProgress);
	if (!Number.isFinite(progress)) {
		progress = -1;
	}

	if (fname) {
		if (progress >= 100) {
			return 'complete';
		}
		if (st === 5) {
			return 'paused';
		}
		if (st === 4) {
			return 'stopped';
		}
		if (st === 1) {
			return 'printing';
		}
		if (st === 0) {
			return 'preparing';
		}
		if (Number(ct.deviceState) > 0) {
			return 'preparing';
		}
	}

	if (klipperState && klipperState !== 'standby' && klipperState !== 'unknown') {
		return klipperState;
	}

	return klipperState || 'standby';
}

/** Known Creality model codes → display name */
const MODEL_NAMES = {
	F022: 'SPARKX i7',
};

/**
 * @param {unknown} modelCode
 * @param {unknown} hostname
 * @returns {string}
 */
function resolveModelName(modelCode, hostname) {
	const code = modelCode != null ? String(modelCode).trim() : '';
	if (code && MODEL_NAMES[code]) {
		return MODEL_NAMES[code];
	}
	const host = hostname != null ? String(hostname).trim() : '';
	if (host && !/^F\d{3}/i.test(host)) {
		return host;
	}
	return code || host || '';
}

/**
 * Parse Creality `modelVersion` string for printer software version.
 *
 * @param {unknown} modelVersion raw `modelVersion` from Creality WS
 * @returns {string} printer software version or empty string
 */
function parseCrealityFirmware(modelVersion) {
	const raw = modelVersion != null ? String(modelVersion) : '';
	const m = raw.match(/printer\s+sw\s+ver:\s*([^;]*)/i);
	const ver = m ? m[1].trim() : '';
	return ver || '';
}

/**
 * @param {unknown} seconds
 * @returns {number|null}
 */
function secondsToHours(seconds) {
	const sec = Number(seconds);
	if (!Number.isFinite(sec) || sec < 0) {
		return null;
	}
	return Math.round((sec / 3600) * 10) / 10;
}

/**
 * @param {unknown} bytes
 * @returns {number|null}
 */
function bytesToGb(bytes) {
	const v = Number(bytes);
	if (!Number.isFinite(v) || v < 0) {
		return null;
	}
	return Math.round((v / 1024 / 1024 / 1024) * 100) / 100;
}

/**
 * @param {unknown} n
 * @param {number} [digits]
 * @returns {number|null}
 */
function roundN(n, digits = 1) {
	const v = Number(n);
	if (!Number.isFinite(v)) {
		return null;
	}
	const f = 10 ** digits;
	return Math.round(v * f) / f;
}

/**
 * @param {string} state
 * @param {number} progress01
 * @param {number} printDuration
 * @param {number} estimatedTime
 * @returns {number}
 */
function calcRemaining(state, progress01, printDuration, estimatedTime) {
	if (state !== 'printing' && state !== 'paused') {
		return 0;
	}

	let remaining = 0;
	if (estimatedTime > 0 && progress01 > 0) {
		remaining = estimatedTime * (1 - progress01);
	} else if (estimatedTime > 0) {
		remaining = estimatedTime - printDuration;
	} else if (progress01 > 0.01) {
		remaining = printDuration / progress01 - printDuration;
	}
	return Math.max(0, remaining);
}

module.exports = {
	CFS_SLOTS,
	EXTERNAL_RACK_SLOT,
	MATERIAL_TYPE_BY_ID,
	SELF_TEST_STEP_LABELS,
	SELF_TEST_STEP_STATES,
	isUnreachableError,
	formatHms,
	formatFinishAt,
	rawName,
	normalizeColor,
	resolveMaterialName,
	round1,
	pinToPwmScale,
	pinToPercent,
	pinToUiPercent,
	parseCfs,
	mapUiState,
	calcRemaining,
	resolveModelName,
	parseCrealityFirmware,
	secondsToHours,
	bytesToGb,
	roundN,
};
