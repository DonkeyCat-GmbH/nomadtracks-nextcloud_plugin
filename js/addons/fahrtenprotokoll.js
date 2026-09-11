/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Add-on: Fahrtenprotokoll — the Austrian practice-drive logbook.
 *
 * Exports the selected tracks as a "Fahrtenprotokoll gemäß § 19 Abs. 8
 * FSG", the sheet driving schools hand out for L / L17 practice drives
 * (Übungsfahrten need 1 000 km of them, signed per drive by the
 * accompanying person and the learner). Columns: Datum, gefahrene km,
 * Kilometerstand von/bis, Kfz-Kennzeichen, Tageszeit, Fahrstrecke/-ziel,
 * Straßenzustand/Witterung, and one signature column each for
 * Begleiter and Bewerber. A GPX only knows some of these; the rest stay
 * empty to be filled in by hand (the sheet has to be signed by hand
 * anyway). The sheet is German regardless of the UI language — it is
 * an Austrian form.
 *
 * Registered with NT.addons (see js/addons.js for the contract) and
 * reached through the "Add-ons" menu of the selection summary.
 */
(function () {
	'use strict';

	const NT = (window.NomadTracks = window.NomadTracks || {});
	const LOGBOOK_STORAGE_KEY = 'nomadtracks-logbook';

	/** UI helpers handed over by the host in render(); see NT.addons. */
	let ui = null;

	function tr(text) {
		return ui.tr(text);
	}

	function makeEl(tag, className, text) {
		return ui.makeEl(tag, className, text);
	}

	function showToast(message) {
		ui.showToast(message);
	}

	function storedLogbookFields() {
		try {
			const raw = window.localStorage.getItem(LOGBOOK_STORAGE_KEY);
			const v = raw ? JSON.parse(raw) : null;
			return {
				name: v && typeof v.name === 'string' ? v.name : '',
				plate: v && typeof v.plate === 'string' ? v.plate : '',
			};
		} catch (e) {
			return { name: '', plate: '' };
		}
	}

	function rememberLogbookFields(fields) {
		try {
			window.localStorage.setItem(LOGBOOK_STORAGE_KEY, JSON.stringify(fields));
		} catch (e) {
			// Fine — they will just have to be typed again next time.
		}
	}

	function render(wrap, ctx) {
		ui = ctx.ui;
		const list = ctx.tracks;
		const agg = ctx.aggregate;
		wrap.classList.add('nt-logbook');
		wrap.appendChild(makeEl('p', 'nt-hint',
			tr('Exports the selected tracks as an Austrian Fahrtenprotokoll (§ 19 Abs. 8 FSG). Odometer readings, road conditions and signatures are left blank to fill in by hand.')));

		const stored = storedLogbookFields();
		const form = makeEl('div', 'nt-logbook-fields');
		const nameInput = makeEl('input');
		nameInput.type = 'text';
		nameInput.placeholder = tr('Name of the learner driver');
		nameInput.value = stored.name;
		nameInput.setAttribute('aria-label', nameInput.placeholder);
		const plateInput = makeEl('input');
		plateInput.type = 'text';
		plateInput.placeholder = tr('Licence plate (Kfz-Kennzeichen)');
		plateInput.value = stored.plate;
		plateInput.setAttribute('aria-label', plateInput.placeholder);
		form.appendChild(nameInput);
		form.appendChild(plateInput);
		wrap.appendChild(form);

		const readFields = function () {
			const fields = { name: nameInput.value.trim(), plate: plateInput.value.trim() };
			rememberLogbookFields(fields);
			return fields;
		};

		const actions = makeEl('div', 'nt-logbook-actions');
		const printBtn = makeEl('button', 'nt-button', tr('Print / save as PDF'));
		printBtn.type = 'button';
		printBtn.addEventListener('click', function () {
			openPrintableLogbook(list, agg, readFields());
		});
		const csvBtn = makeEl('button', 'nt-button', tr('Download CSV'));
		csvBtn.type = 'button';
		csvBtn.addEventListener('click', function () {
			downloadLogbookCsv(list, readFields());
		});
		actions.appendChild(printBtn);
		actions.appendChild(csvBtn);
		wrap.appendChild(actions);

		const untimed = list.filter(function (t) {
			return t.detail.startedAt === null;
		}).length;
		if (untimed > 0) {
			wrap.appendChild(makeEl('p', 'nt-hint',
				tr('%n of the selected tracks have no timestamps and will be listed without a date.')
					.replace('%n', String(untimed))));
		}
	}

	function pad2(n) {
		return n < 10 ? '0' + n : String(n);
	}

	function formatDateDE(epochSeconds) {
		if (!Number.isFinite(epochSeconds)) {
			return '';
		}
		const d = new Date(epochSeconds * 1000);
		return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
	}

	function formatTimeDE(epochSeconds) {
		if (!Number.isFinite(epochSeconds)) {
			return '';
		}
		const d = new Date(epochSeconds * 1000);
		return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
	}

	/** km with one decimal and a German decimal comma. */
	function formatKmDE(meters) {
		return (Math.round(meters / 100) / 10).toFixed(1).replace('.', ',');
	}

	/** One sheet row per track, in the column order of the form. */
	function logbookRows(list, fields) {
		return list.map(function (t) {
			const d = t.detail;
			const start = d.startedAt;
			const end = start !== null && d.durationSeconds !== null
				? start + d.durationSeconds : null;
			let time = formatTimeDE(start);
			if (end !== null) {
				time += ' – ' + formatTimeDE(end);
			}
			const address = t.sidecar ? t.sidecar.address : null;
			const from = address ? (address.city || address.street || '') : '';
			const gpxName = t.gpx && t.gpx.name ? t.gpx.name : t.name;
			const route = from ? gpxName + ' (ab ' + from + ')' : gpxName;
			return {
				date: formatDateDE(start),
				km: formatKmDE(d.distanceMeters || 0),
				odoFrom: '',
				odoTo: '',
				plate: fields.plate,
				time: time,
				route: route,
				conditions: '',
				sortKey: start || 0,
			};
		});
	}

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function openPrintableLogbook(list, agg, fields) {
		const rows = logbookRows(list, fields);
		const heads = ['Datum', 'gefahrene km', 'Kilometerstand von', 'Kilometerstand bis',
			'Kfz-Kennzeichen', 'Tageszeit', 'Fahrstrecke/-ziel', 'Straßenzustand, Witterung',
			'Unterschrift Begleiter/in', 'Unterschrift Bewerber/in'];
		let html = '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">'
			+ '<title>Fahrtenprotokoll</title><style>'
			+ '@page{size:A4 landscape;margin:12mm}'
			+ 'body{font:11pt/1.35 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#000;margin:0}'
			+ 'h1{font-size:15pt;margin:0 0 2mm}'
			+ '.meta{display:flex;gap:12mm;margin:0 0 4mm;font-size:11pt}'
			+ '.meta span{border-bottom:1px solid #000;min-width:50mm;display:inline-block;padding:0 2mm}'
			+ 'table{border-collapse:collapse;width:100%;font-size:9.5pt}'
			+ 'th,td{border:1px solid #000;padding:1.6mm 1.4mm;vertical-align:top;text-align:left}'
			+ 'th{background:#eee;font-weight:600}'
			+ 'td.num{text-align:right;white-space:nowrap}'
			+ 'td.sig{min-width:26mm;height:9mm}'
			+ 'tfoot td{font-weight:600}'
			+ '.note{margin-top:4mm;font-size:8.5pt;color:#333}'
			+ '.screen{margin:0 0 4mm;padding:2mm 3mm;background:#fff3cd;border:1px solid #d9b84a;font-size:10pt}'
			+ '@media print{.screen{display:none}}'
			+ '</style></head><body>'
			+ '<p class="screen">Zum Speichern als PDF: Drucken (⌘P / Strg+P) und als Ziel „Als PDF sichern“ wählen.</p>'
			+ '<h1>Fahrtenprotokoll gemäß § 19 Abs. 8 FSG</h1>'
			+ '<div class="meta">'
			+ '<div>Name: <span>' + escapeHtml(fields.name) + '</span></div>'
			+ '<div>Kfz-Kennzeichen: <span>' + escapeHtml(fields.plate) + '</span></div>'
			+ '<div>Gefahrene Gesamtkilometer: <span>' + formatKmDE(agg.distanceMeters) + ' km</span></div>'
			+ '</div><table><thead><tr>';
		for (const h of heads) {
			html += '<th>' + escapeHtml(h) + '</th>';
		}
		html += '</tr></thead><tbody>';
		for (const r of rows) {
			html += '<tr>'
				+ '<td>' + escapeHtml(r.date) + '</td>'
				+ '<td class="num">' + escapeHtml(r.km) + '</td>'
				+ '<td class="num"></td><td class="num"></td>'
				+ '<td>' + escapeHtml(r.plate) + '</td>'
				+ '<td>' + escapeHtml(r.time) + '</td>'
				+ '<td>' + escapeHtml(r.route) + '</td>'
				+ '<td></td><td class="sig"></td><td class="sig"></td>'
				+ '</tr>';
		}
		html += '</tbody><tfoot><tr><td>Summe</td><td class="num">'
			+ formatKmDE(agg.distanceMeters) + '</td><td colspan="8">'
			+ rows.length + ' Fahrten</td></tr></tfoot></table>'
			+ '<p class="note">Das Fahrtenprotokoll ist wahrheitsgetreu zu führen und für jede Fahrt '
			+ 'von Begleiter/in und Bewerber/in zu unterschreiben. Kilometerstand und '
			+ 'Straßenzustand/Witterung sind händisch zu ergänzen. Erstellt mit NomadTracks am '
			+ formatDateDE(Date.now() / 1000) + '.</p>'
			+ '</body></html>';

		const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
		const w = window.open(url, '_blank');
		if (!w) {
			showToast(tr('The browser blocked the print window. Allow pop-ups for this site and try again.'));
			return;
		}
		// Kick off the print dialog once the sheet has rendered; if
		// the browser does not fire this, the sheet explains ⌘P.
		w.addEventListener('load', function () {
			setTimeout(function () {
				try {
					w.print();
				} catch (e) {
					// The on-screen hint covers this case.
				}
			}, 250);
		});
	}

	function downloadLogbookCsv(list, fields) {
		const rows = logbookRows(list, fields);
		const heads = ['Datum', 'gefahrene km', 'Kilometerstand von', 'Kilometerstand bis',
			'Kfz-Kennzeichen', 'Tageszeit', 'Fahrstrecke/-ziel', 'Straßenzustand, Witterung',
			'Unterschrift Begleiter/in', 'Unterschrift Bewerber/in'];
		const cell = function (v) {
			return '"' + String(v).replace(/"/g, '""') + '"';
		};
		const lines = [];
		if (fields.name) {
			lines.push(cell('Name') + ';' + cell(fields.name));
		}
		lines.push(heads.map(cell).join(';'));
		for (const r of rows) {
			lines.push([r.date, r.km, r.odoFrom, r.odoTo, r.plate, r.time, r.route,
				r.conditions, '', ''].map(cell).join(';'));
		}
		// BOM + semicolons: what German-locale spreadsheets expect.
		const blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'],
			{ type: 'text/csv;charset=utf-8' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'Fahrtenprotokoll-' + formatDateDE(Date.now() / 1000).replace(/\./g, '-') + '.csv';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function () {
			URL.revokeObjectURL(a.href);
		}, 10000);
	}

	NT.addons.register({
		id: 'fahrtenprotokoll',
		title: function () {
			return tr('Fahrtenprotokoll (practice drives)');
		},
		description: function () {
			return tr('Export the selected drives as an Austrian practice-driving logbook — print / PDF or CSV.');
		},
		appliesTo: function (ctx) {
			return ctx.tracks.length > 0;
		},
		render: render,
	});
})();
