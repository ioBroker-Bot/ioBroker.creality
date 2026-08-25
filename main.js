'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 * Creality SPARKX i7 / Moonraker + Creality WebSocket
 */

const utils = require('@iobroker/adapter-core');
const { MoonrakerClient } = require('./lib/moonraker');
const { CrealityWsClient } = require('./lib/crealityWs');
const {
	CFS_SLOTS,
	SELF_TEST_STEP_STATES,
	isUnreachableError,
	formatHms,
	formatFinishAt,
	rawName,
	round1,
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
} = require('./lib/helpers');

class Creality extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	constructor(options) {
		super({
			...options,
			name: 'creality',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.moonraker = null;
		this.crealityWs = null;
		this.pollTimer = null;
		this.lastFilename = '';
		this.estimatedTime = 0;
		this.lastKlipperState = 'standby';
		this.moonrakerReachable = true;
		this.polling = false;
		this.stopping = false;
		this.pollIntervalMs = 5000;
		this.printerHost = '';
		/** @type {number|null} detected Creality fan0_min (PWM 0–255) */
		this.detectedFan0Min = null;
		this.fanMinRefreshAt = 0;
	}

	async onReady() {
		const host = String(this.config.host || '').trim();
		this.printerHost = host;
		const moonrakerPort = Number(this.config.moonrakerPort) || 7125;
		const crealityWsPort = Number(this.config.crealityWsPort) || 9999;
		const pollInterval = Math.max(2, Number(this.config.pollInterval) || 5);
		this.pollIntervalMs = pollInterval * 1000;
		this.stopping = false;
		const apiKey = String(this.config.apiKey || '').trim();

		if (!host) {
			this.log.error('Please set the printer host/IP in the adapter settings');
			await this.setState('info.connection', false, true);
			return;
		}

		this.moonraker = new MoonrakerClient({
			host,
			port: moonrakerPort,
			apiKey,
			timeoutMs: 15000,
		});

		await this.ensureObjects();
		await this.setState('info.connection', false, true);
		await this.refreshWebcamUrls();

		this.crealityWs = new CrealityWsClient({
			host,
			port: crealityWsPort,
			log: this.log,
			setTimeout: (...args) => this.setTimeout(...args),
			clearTimeout: id => this.clearTimeout(id),
		});
		this.crealityWs.on('telem', () => {
			this.publishUiState(null);
			this.publishProgressFromCreality();
			this.publishDeviceInfoFromCreality();
			this.publishControlsFromCreality();
		});
		this.crealityWs.start();

		if (this.config.enableControl !== false) {
			this.subscribeStates('control.*');
			if (this.config.enableCfs !== false) {
				this.subscribeStates('cfs.light');
			}
		}

		this.log.info(
			`Creality adapter started → ${host} (Moonraker :${moonrakerPort}, Creality-WS :${crealityWsPort}, poll ${pollInterval}s)`,
		);

		await this.poll().catch(err => this.logMoonrakerUnreachable(err));
		this.scheduleNextPoll();
	}

	/**
	 * Schedule the next Moonraker poll after the previous one finished (setTimeout chain).
	 *
	 * @returns {void}
	 */
	scheduleNextPoll() {
		if (this.stopping) {
			return;
		}
		if (this.pollTimer) {
			this.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		this.pollTimer = this.setTimeout(() => {
			this.pollTimer = null;
			this.poll()
				.catch(err => this.logMoonrakerUnreachable(err))
				.finally(() => this.scheduleNextPoll());
		}, this.pollIntervalMs);
	}

	/**
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.stopping = true;
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
				this.pollTimer = null;
			}
			if (this.crealityWs) {
				this.crealityWs.stop();
				this.crealityWs = null;
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}

	/**
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}
		const shortId = id.replace(`${this.namespace}.`, '');

		try {
			if (shortId === 'control.light') {
				await this.crealityWs?.set({ lightSw: state.val ? 1 : 0 });
				await this.setStateAsync('control.light', !!state.val, true);
				this.log.info(`Toolhead LED → ${state.val ? 'ON' : 'OFF'}`);
				return;
			}
			if (shortId === 'control.sleepMode') {
				await this.crealityWs?.set({ sleepMode: state.val ? 1 : 0 });
				await this.setStateAsync('control.sleepMode', !!state.val, true);
				this.log.info(`Sleep mode → ${state.val ? 'ON' : 'OFF'}`);
				return;
			}
			if (shortId === 'cfs.light') {
				await this.moonraker?.sendGcode(`LED_SWITCH SWITCH=${state.val ? 1 : 0}`);
				await this.setStateAsync('cfs.light', !!state.val, true);
				this.log.info(`CFS box LED → ${state.val ? 'ON' : 'OFF'}`);
				return;
			}
			if (shortId === 'control.pause') {
				if (state.val) {
					try {
						await this.crealityWs?.set({ pause: 1 });
					} catch {
						await this.moonraker?.sendGcode('PAUSE');
					}
					this.log.info('Print → pause');
				}
				await this.setStateAsync('control.pause', false, true);
				return;
			}
			if (shortId === 'control.resume') {
				if (state.val) {
					try {
						await this.crealityWs?.set({ pause: 0 });
					} catch {
						await this.moonraker?.sendGcode('RESUME');
					}
					this.log.info('Print → resume');
				}
				await this.setStateAsync('control.resume', false, true);
				return;
			}
			if (shortId === 'control.stop') {
				if (state.val) {
					try {
						await this.crealityWs?.set({ stop: 1 });
					} catch {
						await this.moonraker?.sendGcode('CANCEL_PRINT');
					}
					this.log.info('Print → stop');
				}
				await this.setStateAsync('control.stop', false, true);
			}
		} catch (e) {
			this.log.error(`Control failed (${shortId}): ${e.message}`);
		}
	}

	/**
	 * @param {string} id
	 * @param {any} init
	 * @param {Partial<ioBroker.StateCommon> & {name?: ioBroker.StringOrTranslated, type?: ioBroker.CommonType}} common
	 */
	async ensureState(id, init, common) {
		const existing = await this.getObjectAsync(id);
		const defaultRole = common.type === 'boolean' ? 'indicator' : common.type === 'string' ? 'text' : 'value';
		const fullCommon = {
			read: true,
			write: false,
			role: common.role || defaultRole,
			...common,
		};
		// Buttons are write-only events per ioBroker role spec
		if (fullCommon.role === 'button' && common.read === undefined) {
			fullCommon.read = false;
		}
		if (!existing) {
			await this.setObjectNotExistsAsync(id, {
				type: 'state',
				common: fullCommon,
				native: {},
			});
			const cur = await this.getStateAsync(id);
			if (cur === null || cur === undefined) {
				await this.setStateAsync(id, { val: init, ack: true });
			}
			return;
		}
		const patch = {};
		if (common.name && existing.common && existing.common.name !== common.name) {
			patch.name = common.name;
		}
		if (common.states) {
			patch.states = common.states;
		}
		if (common.unit !== undefined && existing.common && existing.common.unit !== common.unit) {
			patch.unit = common.unit;
		}
		if (fullCommon.role && existing.common && existing.common.role !== fullCommon.role) {
			patch.role = fullCommon.role;
		}
		if (fullCommon.type && existing.common && existing.common.type !== fullCommon.type) {
			patch.type = fullCommon.type;
		}
		if (existing.common && existing.common.read !== fullCommon.read) {
			patch.read = fullCommon.read;
		}
		if (existing.common && existing.common.write !== fullCommon.write) {
			patch.write = fullCommon.write;
		}
		if (Object.keys(patch).length) {
			await this.extendObjectAsync(id, { common: patch });
		}
	}

	async ensureChannel(id, name) {
		await this.setObjectNotExistsAsync(id, {
			type: 'channel',
			common: { name },
			native: {},
		});
	}

	async ensureObjects() {
		for (const [id, init, common] of [
			['model', '', { name: 'Printer model', type: 'string' }],
			['firmware', '', { name: 'Firmware version', type: 'string' }],
			['hostname', '', { name: 'Hostname', type: 'string' }],
			['deviceSn', '', { name: 'Device serial', type: 'string' }],
			['nozzleSize', 0, { name: 'Nozzle size', type: 'number', unit: 'mm' }],
			['printHours', 0, { name: 'Total print hours', type: 'number', unit: 'h' }],
			['printJobs', 0, { name: 'Total print jobs', type: 'number' }],
			['filamentTotal', 0, { name: 'Total filament used', type: 'number', unit: 'g' }],
			['diskUsed', 0, { name: 'Disk used', type: 'number', unit: 'GB' }],
			['diskTotal', 0, { name: 'Disk total', type: 'number', unit: 'GB' }],
			['materialStatus', 0, { name: 'Material status (raw)', type: 'number' }],
			['errorCode', 0, { name: 'Error code', type: 'number' }],
			['error', '', { name: 'Error message', type: 'string' }],
		]) {
			await this.ensureState(`info.${id}`, init, /** @type {ioBroker.StateCommon} */ (common));
		}

		const root = [
			['state', '', { name: 'Print status (UI)', type: 'string' }],
			['stateKlipper', '', { name: 'Print status (Klipper/Moonraker)', type: 'string' }],
			['selfTestStep', 0, { name: 'Self-test step', type: 'number', states: SELF_TEST_STEP_STATES }],
		];
		for (const [id, init, common] of root) {
			await this.ensureState(id, init, common);
		}

		await this.ensureChannel('currentJob', 'Current print job');
		for (const [id, init, common] of [
			['progress', 0, { name: 'Progress %', type: 'number', unit: '%' }],
			['printName', '', { name: 'Print file', type: 'string' }],
			['remainingText', '00:00:00', { name: 'Remaining time', type: 'string' }],
			['finishAt', '', { name: 'Finish at (local YYYY-MM-DD HH:MM)', type: 'string' }],
			['printTime', '00:00:00', { name: 'Elapsed print time', type: 'string' }],
			['layer', 0, { name: 'Current layer', type: 'number' }],
			['totalLayers', 0, { name: 'Total layers', type: 'number' }],
			['feedrate', 100, { name: 'Feedrate %', type: 'number', unit: '%' }],
			['flowrate', 100, { name: 'Flowrate %', type: 'number', unit: '%' }],
			['speed', 0, { name: 'Realtime speed', type: 'number', unit: 'mm/s' }],
			['flow', 0, { name: 'Realtime flow', type: 'number', unit: 'mm³/s' }],
			['filamentSlot', '', { name: 'Active filament slot', type: 'string' }],
			['filamentMaterial', '', { name: 'Active filament material', type: 'string' }],
			['filamentColor', '', { name: 'Active filament color', type: 'string' }],
			['filamentUsed', 0, { name: 'Filament used (job)', type: 'number', unit: 'g' }],
			['filamentLength', 0, { name: 'Filament length (job)', type: 'number', unit: 'mm' }],
		]) {
			await this.ensureState(`currentJob.${id}`, init, /** @type {ioBroker.StateCommon} */ (common));
		}

		for (const id of [
			'progress',
			'printName',
			'remainingText',
			'finishAt',
			'filamentSlot',
			'filamentMaterial',
			'filamentColor',
			'printNameShort',
		]) {
			try {
				await this.delObjectAsync(id);
			} catch {
				// ignore
			}
		}

		await this.ensureChannel('temp', 'Temperatures');
		for (const [id, name] of [
			['nozzleTemp', 'Nozzle actual °C'],
			['nozzleTarget', 'Nozzle target °C'],
			['bedTemp', 'Bed actual °C'],
			['bedTarget', 'Bed target °C'],
			['box', 'Box / chamber °C'],
		]) {
			await this.ensureState(`temp.${id}`, 0, {
				name,
				type: 'number',
				unit: '°C',
				role: 'value.temperature',
			});
		}

		if (this.config.enableFans !== false) {
			await this.ensureChannel('fans', 'Fans');
			for (const [id, name, unit] of [
				['partCooling', 'Part cooling % (UI / slicer)', '%'],
				['partCoolingPwm', 'Part cooling PWM % (hardware)', '%'],
				['partCoolingRpm', 'Part cooling RPM', 'rpm'],
				['hotend', 'Hotend fan %', '%'],
				['board', 'Board fan %', '%'],
				['aux', 'Aux / E fan %', '%'],
			]) {
				await this.ensureState(`fans.${id}`, 0, { name, type: 'number', unit });
			}
		}

		if (this.config.enableCfs !== false) {
			await this.ensureChannel('cfs', 'CFS');
			for (const [id, init, common] of [
				['type', '', { name: 'CFS type', type: 'string' }],
				['state', '', { name: 'CFS state', type: 'string' }],
				['enable', false, { name: 'CFS enabled', type: 'boolean' }],
				[
					'temperature',
					0,
					{ name: 'CFS temperature °C', type: 'number', unit: '°C', role: 'value.temperature' },
				],
				['humidity', 0, { name: 'CFS humidity %', type: 'number', unit: '%', role: 'value.humidity' }],
				['light', false, { name: 'CFS box LED', type: 'boolean', write: true, role: 'switch' }],
			]) {
				await this.ensureState(`cfs.${id}`, init, common);
			}
			for (const slot of CFS_SLOTS) {
				await this.ensureChannel(`cfs.${slot}`, slot);
				await this.ensureState(`cfs.${slot}.color`, '', { name: `${slot} color`, type: 'string' });
				await this.ensureState(`cfs.${slot}.material`, '', {
					name: `${slot} material`,
					type: 'string',
				});
				await this.ensureState(`cfs.${slot}.occupied`, false, {
					name: `${slot} occupied`,
					type: 'boolean',
				});
				await this.ensureState(`cfs.${slot}.active`, false, {
					name: `${slot} active`,
					type: 'boolean',
				});
			}
		}

		await this.ensureChannel('webcam', 'Webcam');
		await this.ensureState('webcam.available', false, {
			name: 'Webcam available (read-only)',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('webcam.streamUrl', '', {
			name: 'Webcam page / stream URL (iframe)',
			type: 'string',
			role: 'text.url',
		});
		await this.ensureState('webcam.webrtcUrl', '', {
			name: 'WebRTC signaling URL',
			type: 'string',
			role: 'text.url',
		});
		try {
			await this.delObjectAsync('webcam.on');
		} catch {
			// ignore
		}

		if (this.config.enableControl !== false) {
			await this.ensureChannel('control', 'Control');
			await this.ensureState('control.light', false, {
				name: 'Toolhead LED',
				type: 'boolean',
				write: true,
				role: 'switch',
			});
			await this.ensureState('control.sleepMode', false, {
				name: 'Sleep mode (all LEDs off)',
				type: 'boolean',
				write: true,
				role: 'switch',
			});
			for (const [id, name] of [
				['pause', 'Pause'],
				['resume', 'Resume'],
				['stop', 'Stop / cancel'],
			]) {
				await this.ensureState(`control.${id}`, false, {
					name,
					type: 'boolean',
					write: true,
					read: false,
					role: 'button',
				});
			}
		}
	}

	defaultWebcamUrls() {
		const host = this.printerHost;
		const port = Number(this.config.webcamPort) || 8000;
		const override = String(this.config.webcamStreamUrl || '').trim();
		return {
			streamUrl: override || (host ? `http://${host}:${port}` : ''),
			webrtcUrl: host ? `http://${host}:${port}/call/webrtc_local` : '',
		};
	}

	async refreshWebcamUrls() {
		const defaults = this.defaultWebcamUrls();
		let streamUrl = defaults.streamUrl;
		const webrtcUrl = defaults.webrtcUrl;

		if (!String(this.config.webcamStreamUrl || '').trim() && this.moonraker) {
			try {
				const data = await this.moonraker.getWebcams();
				const cams = (data && data.result && data.result.webcams) || [];
				const first = cams.find(c => c && c.stream_url) || cams[0];
				if (first && first.stream_url) {
					streamUrl = String(first.stream_url);
				}
			} catch (e) {
				if (!isUnreachableError(e)) {
					this.log.debug(`Webcam list: ${e.message}`);
				}
			}
		}

		await this.setStateAsync('webcam.streamUrl', streamUrl, true);
		await this.setStateAsync('webcam.webrtcUrl', webrtcUrl, true);
	}

	/**
	 * @param {string|null} klipperState
	 */
	publishUiState(klipperState) {
		if (klipperState != null) {
			this.lastKlipperState = klipperState;
		}
		const telem = (this.crealityWs && this.crealityWs.telem) || {};
		const ui = mapUiState(this.lastKlipperState, telem);
		this.setState('state', ui, true);
		this.setState('stateKlipper', this.lastKlipperState || '', true);
		const step = telem.selfTestStep;
		this.setState('selfTestStep', step != null && step !== '' ? Number(step) : 0, true);
	}

	publishControlsFromCreality() {
		const ct = (this.crealityWs && this.crealityWs.telem) || {};
		if (this.config.enableControl !== false) {
			if (ct.lightSw !== undefined) {
				this.setState('control.light', Number(ct.lightSw) > 0, true);
			}
			if (ct.sleepMode !== undefined) {
				this.setState('control.sleepMode', Number(ct.sleepMode) > 0, true);
			}
		}
		if (ct.video !== undefined) {
			this.setState('webcam.available', Number(ct.video) > 0, true);
		}
	}

	publishProgressFromCreality() {
		const ct = (this.crealityWs && this.crealityWs.telem) || {};
		let progress = Number(ct.printProgress != null ? ct.printProgress : ct.dProgress);
		if (Number.isFinite(progress) && progress >= 0) {
			this.setState('currentJob.progress', Math.round(progress * 10) / 10, true);
		}

		let remainingSec = Number(ct.printLeftTime);
		if (!Number.isFinite(remainingSec) || remainingSec < 0) {
			remainingSec = 0;
		}
		const ui = mapUiState(this.lastKlipperState, ct);
		if (ui === 'printing' || ui === 'paused' || ui === 'leveling' || ui === 'self-testing' || ui === 'preparing') {
			this.setState('currentJob.remainingText', formatHms(remainingSec), true);
			this.setState('currentJob.finishAt', formatFinishAt(remainingSec), true);
		}
		const fname = ct.printFileName ? String(ct.printFileName) : '';
		if (fname) {
			this.setState('currentJob.printName', rawName(fname), true);
		}

		const jobSec = Number(ct.printJobTime);
		if (Number.isFinite(jobSec) && jobSec >= 0) {
			this.setState('currentJob.printTime', formatHms(jobSec), true);
		}
		if (ct.layer != null && ct.layer !== '') {
			this.setState('currentJob.layer', Number(ct.layer) || 0, true);
		}
		if (ct.TotalLayer != null && ct.TotalLayer !== '') {
			this.setState('currentJob.totalLayers', Number(ct.TotalLayer) || 0, true);
		}
		if (ct.curFeedratePct != null) {
			this.setState('currentJob.feedrate', Number(ct.curFeedratePct) || 0, true);
		}
		if (ct.curFlowratePct != null) {
			this.setState('currentJob.flowrate', Number(ct.curFlowratePct) || 0, true);
		}
		const speed = roundN(ct.realTimeSpeed, 1);
		if (speed != null) {
			this.setState('currentJob.speed', speed, true);
		}
		const flow = roundN(ct.realTimeFlow, 2);
		if (flow != null) {
			this.setState('currentJob.flow', flow, true);
		}
		if (ct.ConsumablesWeight != null) {
			this.setState('currentJob.filamentUsed', Number(ct.ConsumablesWeight) || 0, true);
		}
		if (ct.usedMaterialLength != null) {
			this.setState('currentJob.filamentLength', Number(ct.usedMaterialLength) || 0, true);
		}
	}

	publishDeviceInfoFromCreality() {
		const ct = (this.crealityWs && this.crealityWs.telem) || {};
		const model = resolveModelName(ct.model, ct.hostname);
		if (model) {
			this.setState('info.model', model, true);
		}
		const firmware = parseCrealityFirmware(ct.modelVersion);
		if (firmware) {
			this.setState('info.firmware', firmware, true);
		}
		if (ct.hostname) {
			this.setState('info.hostname', String(ct.hostname), true);
		}
		if (ct.deviceSn) {
			this.setState('info.deviceSn', String(ct.deviceSn), true);
		}
		const nozzle = roundN(ct.nozzleSize, 2);
		if (nozzle != null) {
			this.setState('info.nozzleSize', nozzle, true);
		}
		const hours = secondsToHours(ct.allPrintTime);
		if (hours != null) {
			this.setState('info.printHours', hours, true);
		}
		if (ct.allPrintMaterial != null) {
			this.setState('info.filamentTotal', Number(ct.allPrintMaterial) || 0, true);
		}
		const used = bytesToGb(ct.diskUsedSize);
		const total = bytesToGb(ct.diskTotalSize);
		if (used != null) {
			this.setState('info.diskUsed', used, true);
		}
		if (total != null) {
			this.setState('info.diskTotal', total, true);
		}
		if (ct.materialStatus != null) {
			this.setState('info.materialStatus', Number(ct.materialStatus) || 0, true);
		}
		const err = ct.err || {};
		const errCode = err.errcode != null ? Number(err.errcode) : 0;
		this.setState('info.errorCode', Number.isFinite(errCode) ? errCode : 0, true);
		this.setState('info.error', err.value != null ? String(err.value) : '', true);

		const box = round1(ct.boxTemp);
		if (box != null) {
			this.setState('temp.box', box, true);
		}
	}

	/**
	 * Effective fan0_min for Creality M106 UI remapping.
	 * Config `fan0Min` >= 0 overrides auto-detect from PRINTER_PARAM.
	 *
	 * @returns {number}
	 */
	resolveFan0Min() {
		const cfg = Number(this.config.fan0Min);
		if (Number.isFinite(cfg) && cfg >= 0) {
			return Math.min(254, cfg);
		}
		if (this.detectedFan0Min != null && Number.isFinite(this.detectedFan0Min)) {
			return Math.min(254, Math.max(0, this.detectedFan0Min));
		}
		return 0;
	}

	/**
	 * Refresh Creality PRINTER_PARAM.fan0_min (cached ~5 minutes).
	 *
	 * @returns {Promise<void>}
	 */
	async refreshDetectedFanMins() {
		if (!this.moonraker || this.config.enableFans === false) {
			return;
		}
		const now = Date.now();
		if (this.detectedFan0Min != null && now - this.fanMinRefreshAt < 5 * 60 * 1000) {
			return;
		}
		const param = await this.moonraker.getPrinterParam();
		if (!param) {
			return;
		}
		const min = Number(param.fan0_min);
		if (Number.isFinite(min) && min >= 0) {
			if (this.detectedFan0Min !== min) {
				this.log.debug(`Detected Creality fan0_min=${min} (UI% remapping for part cooling)`);
			}
			this.detectedFan0Min = min;
			this.fanMinRefreshAt = now;
		}
	}

	/**
	 * @param {unknown} err
	 */
	logMoonrakerUnreachable(err) {
		const errObj = /** @type {{message?: string}|null|undefined} */ (err);
		const msg = errObj && errObj.message ? errObj.message : String(err);
		if (isUnreachableError(err)) {
			if (this.moonrakerReachable) {
				this.log.info(`Moonraker unreachable: ${msg}`);
				this.moonrakerReachable = false;
			}
			return;
		}
		this.log.warn(`Moonraker poll: ${msg}`);
	}

	logMoonrakerReachableAgain() {
		if (!this.moonrakerReachable) {
			this.log.info('Moonraker reachable again');
			this.moonrakerReachable = true;
		}
	}

	async poll() {
		if (this.polling || !this.moonraker) {
			return;
		}
		this.polling = true;
		try {
			const data = await this.moonraker.queryCore();
			const st = (data && data.result && data.result.status) || {};
			const ps = st.print_stats || {};
			const ds = st.display_status || {};
			const vs = st.virtual_sdcard || {};
			const ex = st.extruder || {};
			const bed = st.heater_bed || {};
			const fb = st.fan_feedback || {};
			const fan0 = st['output_pin fan0'] || {};
			const boardFan = st['output_pin board_fan'] || {};
			const eFan = st['output_pin e_fan'] || {};
			const hotendFan = st['heater_fan hotend_fan'] || {};

			/** @type {{
			 *   type: string,
			 *   state: string,
			 *   enable: boolean,
			 *   temperature: number|null,
			 *   humidity: number|null,
			 *   activeSlot: string,
			 *   activeColor: string,
			 *   activeMaterial: string,
			 *   slots: Record<string, any>,
			 * }} */
			let cfs = {
				type: '',
				state: '',
				enable: false,
				temperature: null,
				humidity: null,
				activeSlot: '',
				activeColor: '',
				activeMaterial: '',
				slots: {},
			};
			if (this.config.enableCfs !== false) {
				try {
					const cfsData = await this.moonraker.queryCfs();
					const cst = (cfsData && cfsData.result && cfsData.result.status) || {};
					cfs = parseCfs(cst.box, cst.filament_inventory_manager, cst.filament_rack);
				} catch (e) {
					if (!isUnreachableError(e)) {
						this.log.warn(`CFS poll: ${e.message}`);
					}
				}
			}

			const state = ps.state || 'unknown';
			const filename = ps.filename || '';
			let progress01 = Number(ds.progress != null ? ds.progress : vs.progress != null ? vs.progress : 0);
			const telem = (this.crealityWs && this.crealityWs.telem) || {};
			const ctProg = Number(telem.printProgress != null ? telem.printProgress : telem.dProgress);
			if ((!progress01 || progress01 <= 0) && Number.isFinite(ctProg) && ctProg > 0) {
				progress01 = ctProg / 100;
			}
			const progress = Math.round(progress01 * 1000) / 10;
			const printDuration = Number(ps.print_duration) || 0;

			if (filename && filename !== this.lastFilename) {
				this.lastFilename = filename;
				try {
					this.estimatedTime = await this.moonraker.getEstimatedTime(filename);
				} catch (e) {
					if (!isUnreachableError(e)) {
						this.log.warn(`Metadata: ${e.message}`);
					}
					this.estimatedTime = 0;
				}
			}
			if (!filename) {
				this.lastFilename = '';
				this.estimatedTime = 0;
			}

			let remainingSec = calcRemaining(state, progress01, printDuration, this.estimatedTime);
			const ctLeft = Number(telem.printLeftTime);
			if ((!remainingSec || remainingSec <= 0) && Number.isFinite(ctLeft) && ctLeft > 0) {
				remainingSec = ctLeft;
			}

			await this.setStateAsync('info.connection', true, true);
			this.logMoonrakerReachableAgain();
			this.publishUiState(state);
			this.publishProgressFromCreality();
			await this.setStateAsync('currentJob.progress', progress, true);
			await this.setStateAsync('currentJob.printName', rawName(filename), true);
			await this.setStateAsync('currentJob.remainingText', formatHms(remainingSec), true);
			await this.setStateAsync('currentJob.finishAt', formatFinishAt(remainingSec), true);

			await this.setStateAsync('temp.nozzleTemp', round1(ex.temperature), true);
			await this.setStateAsync('temp.nozzleTarget', round1(ex.target), true);
			await this.setStateAsync('temp.bedTemp', round1(bed.temperature), true);
			await this.setStateAsync('temp.bedTarget', round1(bed.target), true);

			if (this.config.enableFans !== false) {
				await this.refreshDetectedFanMins();
				const fan0Min = this.resolveFan0Min();
				const partPwm = pinToPercent(fan0.value);
				const partUi = pinToUiPercent(fan0.value, fan0Min);
				await this.setStateAsync('fans.partCooling', partUi, true);
				await this.setStateAsync('fans.partCoolingPwm', partPwm, true);
				await this.setStateAsync('fans.partCoolingRpm', Number(fb.fan0_speed) || 0, true);
				await this.setStateAsync('fans.hotend', pinToPercent(hotendFan.speed), true);
				await this.setStateAsync('fans.board', pinToPercent(boardFan.value), true);
				await this.setStateAsync('fans.aux', pinToPercent(eFan.value), true);
			}

			await this.setStateAsync('currentJob.filamentSlot', cfs.activeSlot, true);
			await this.setStateAsync('currentJob.filamentMaterial', cfs.activeMaterial, true);
			await this.setStateAsync('currentJob.filamentColor', cfs.activeColor, true);

			if (this.config.enableCfs !== false) {
				await this.setStateAsync('cfs.type', cfs.type, true);
				await this.setStateAsync('cfs.state', cfs.state, true);
				await this.setStateAsync('cfs.enable', cfs.enable, true);
				await this.setStateAsync('cfs.temperature', cfs.temperature, true);
				await this.setStateAsync('cfs.humidity', cfs.humidity, true);
				for (const slotId of CFS_SLOTS) {
					const s = cfs.slots[slotId] || {
						color: '',
						material: '',
						occupied: false,
						active: false,
					};
					await this.setStateAsync(`cfs.${slotId}.color`, s.color, true);
					await this.setStateAsync(`cfs.${slotId}.material`, s.material, true);
					await this.setStateAsync(`cfs.${slotId}.occupied`, s.occupied, true);
					await this.setStateAsync(`cfs.${slotId}.active`, s.active, true);
				}
			}

			this.publishDeviceInfoFromCreality();
			this.publishControlsFromCreality();

			try {
				const hist = await this.moonraker.getHistoryTotals();
				const totals = (hist && hist.result && hist.result.job_totals) || {};
				if (totals.total_jobs != null) {
					await this.setStateAsync('info.printJobs', Number(totals.total_jobs) || 0, true);
				}
				const ctPrintTime = Number(telem.allPrintTime);
				if (!Number.isFinite(ctPrintTime) || ctPrintTime < 0) {
					const hours = secondsToHours(totals.total_print_time);
					if (hours != null) {
						await this.setStateAsync('info.printHours', hours, true);
					}
				}
			} catch (e) {
				if (!isUnreachableError(e)) {
					this.log.warn(`History totals: ${e.message}`);
				}
			}

			await this.refreshWebcamUrls();
		} catch (e) {
			this.logMoonrakerUnreachable(e);
			this.publishProgressFromCreality();
			this.publishDeviceInfoFromCreality();
			this.publishControlsFromCreality();
			this.publishUiState(null);
			const wsOk = !!(this.crealityWs && this.crealityWs.isOpen());
			await this.setStateAsync('info.connection', wsOk, true);
		} finally {
			this.polling = false;
		}
	}
}

if (require.main !== module) {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	module.exports = options => new Creality(options);
} else {
	new Creality();
}
