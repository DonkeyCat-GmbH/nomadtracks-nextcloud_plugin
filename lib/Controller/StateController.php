<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NomadTracks\Controller;

use OCA\NomadTracks\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IRequest;

/**
 * The user's "shown on map" selection: which tracks are ticked and
 * which POIs are unticked. Stored per user in the app's preferences,
 * so the same selection appears on every device / browser. This is
 * deliberately separate from the mobile app's own `isVisibleOnMap`
 * flag in the synced files — the web app never writes to those.
 */
class StateController extends Controller {
	private const KEY = 'selection';

	/** Guard against a runaway client filling the preferences table. */
	private const MAX_PATHS = 5000;
	private const MAX_PATH_LENGTH = 1024;

	public function __construct(
		string $appName,
		IRequest $request,
		private IConfig $config,
		private ?string $userId,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function get(): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$raw = $this->config->getUserValue($this->userId, Application::APP_ID, self::KEY, '');
		$data = $raw !== '' ? json_decode($raw, true) : null;
		return new JSONResponse([
			'tracks' => self::pathList($data['tracks'] ?? null),
			'hiddenPois' => self::pathList($data['hiddenPois'] ?? null),
		]);
	}

	/**
	 * Replace the stored selection. The body is the same shape `get`
	 * returns: { tracks: string[], hiddenPois: string[] }.
	 */
	#[NoAdminRequired]
	public function set(): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		// IRequest decodes an application/json body into the params.
		$body = $this->request->getParams();
		if (!is_array($body) || (!isset($body['tracks']) && !isset($body['hiddenPois']))) {
			return new JSONResponse(['error' => 'expected a JSON body with tracks / hiddenPois'], Http::STATUS_BAD_REQUEST);
		}
		$clean = [
			'tracks' => self::pathList($body['tracks'] ?? null),
			'hiddenPois' => self::pathList($body['hiddenPois'] ?? null),
		];
		$this->config->setUserValue(
			$this->userId,
			Application::APP_ID,
			self::KEY,
			json_encode($clean, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
		);
		return new JSONResponse($clean);
	}

	/**
	 * Keep only plausible relative file paths, de-duplicated. Anything
	 * else in the list is dropped rather than rejected, so one odd
	 * entry never loses the whole selection.
	 *
	 * @return string[]
	 */
	private static function pathList(mixed $value): array {
		if (!is_array($value)) {
			return [];
		}
		$out = [];
		foreach ($value as $path) {
			if (!is_string($path) || $path === '' || strlen($path) > self::MAX_PATH_LENGTH) {
				continue;
			}
			if (str_contains($path, "\0") || str_starts_with($path, '/') || str_contains($path, '..')) {
				continue;
			}
			$out[$path] = true;
			if (count($out) >= self::MAX_PATHS) {
				break;
			}
		}
		return array_keys($out);
	}
}
