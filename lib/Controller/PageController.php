<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NomadTracks\Controller;

use OCA\NomadTracks\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
	public function __construct(string $appName, IRequest $request) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		// Vendored MapLibre GL JS first, then the app modules in
		// dependency order (no build step — plain scripts).
		Util::addScript(Application::APP_ID, 'vendor/maplibre-gl/maplibre-gl');
		Util::addScript(Application::APP_ID, 'formats');
		Util::addScript(Application::APP_ID, 'webdav');
		Util::addScript(Application::APP_ID, 'main');
		Util::addStyle(Application::APP_ID, 'vendor/maplibre-gl/maplibre-gl');
		Util::addStyle(Application::APP_ID, 'main');

		$response = new TemplateResponse(Application::APP_ID, 'main');

		$csp = new ContentSecurityPolicy();
		// The basemap style, tiles, glyphs and sprites are fetched from
		// the NomadTracks map server (same server the mobile apps use).
		$csp->addAllowedConnectDomain('https://map.nomadtracks.app');
		$csp->addAllowedImageDomain('https://map.nomadtracks.app');
		// MapLibre GL spawns its worker from a blob: URL.
		$csp->addAllowedWorkerSrcDomain('blob:');
		$response->setContentSecurityPolicy($csp);

		return $response;
	}
}
