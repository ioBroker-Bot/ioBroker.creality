'use strict';

const http = require('node:http');

const QUERY_CORE =
	'/printer/objects/query?print_stats&display_status&virtual_sdcard' +
	'&extruder&heater_bed' +
	'&fan_feedback&heater_fan%20hotend_fan' +
	'&output_pin%20fan0&output_pin%20board_fan&output_pin%20e_fan';

const QUERY_CFS = '/printer/objects/query?box&filament_inventory_manager&filament_rack&smart_filament_rack';

class MoonrakerClient {
	/**
	 * @param {{host: string, port: number, apiKey?: string, timeoutMs?: number}} opts
	 */
	constructor(opts) {
		this.host = opts.host;
		this.port = opts.port;
		this.apiKey = opts.apiKey || '';
		this.timeoutMs = opts.timeoutMs || 15000;
	}

	/**
	 * @param {string} method
	 * @param {string} pathAndQuery
	 * @param {object|null} [bodyObj]
	 * @returns {Promise<any>}
	 */
	request(method, pathAndQuery, bodyObj = null) {
		return new Promise((resolve, reject) => {
			const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
			const opts = {
				host: this.host,
				port: this.port,
				path: pathAndQuery,
				method,
				timeout: this.timeoutMs,
				headers: {},
			};
			if (this.apiKey) {
				opts.headers['X-Api-Key'] = this.apiKey;
			}
			if (body) {
				opts.headers['Content-Type'] = 'application/json';
				opts.headers['Content-Length'] = Buffer.byteLength(body);
			}

			const req = http.request(opts, res => {
				let data = '';
				res.setEncoding('utf8');
				res.on('data', chunk => {
					data += chunk;
				});
				res.on('end', () => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
						return;
					}
					if (!data) {
						resolve(null);
						return;
					}
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(new Error(`JSON parse: ${e.message}`));
					}
				});
			});
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Timeout'));
			});
			req.on('error', reject);
			if (body) {
				req.write(body);
			}
			req.end();
		});
	}

	/**
	 * @param {string} pathAndQuery
	 */
	getJson(pathAndQuery) {
		return this.request('GET', pathAndQuery);
	}

	/**
	 * @param {string} script
	 */
	sendGcode(script) {
		return this.request('POST', '/printer/gcode/script', { script });
	}

	queryCore() {
		return this.getJson(QUERY_CORE);
	}

	queryCfs() {
		return this.getJson(QUERY_CFS);
	}

	/**
	 * @param {string} filename
	 */
	async getEstimatedTime(filename) {
		if (!filename) {
			return 0;
		}
		const data = await this.getJson(`/server/files/metadata?filename=${encodeURIComponent(filename)}`);
		return Number(data && data.result && data.result.estimated_time) || 0;
	}

	getPrinterInfo() {
		return this.getJson('/printer/info');
	}

	getHistoryTotals() {
		return this.getJson('/server/history/totals');
	}

	getWebcams() {
		return this.getJson('/server/webcams/list');
	}

	/**
	 * Creality stores fan minimum PWM in `[gcode_macro PRINTER_PARAM]` (fan0_min, …).
	 * Missing object → resolve null (caller keeps previous / defaults).
	 *
	 * @returns {Promise<object|null>}
	 */
	async getPrinterParam() {
		try {
			const data = await this.getJson('/printer/objects/query?gcode_macro%20PRINTER_PARAM');
			return (
				(data && data.result && data.result.status && data.result.status['gcode_macro PRINTER_PARAM']) || null
			);
		} catch {
			return null;
		}
	}
}

module.exports = {
	MoonrakerClient,
	QUERY_CORE,
	QUERY_CFS,
};
