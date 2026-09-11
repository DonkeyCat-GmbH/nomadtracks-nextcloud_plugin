<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NomadTracks\Listener;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\NomadTracks\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/**
 * Adds the "Open in NomadTracks" file action to the Files app, so a
 * GPX file opens on the NomadTracks map instead of whatever viewer
 * would otherwise claim it.
 *
 * @template-implements IEventListener<LoadAdditionalScriptsEvent>
 */
class LoadAdditionalScriptsListener implements IEventListener {
	public function handle(Event $event): void {
		if (!($event instanceof LoadAdditionalScriptsEvent)) {
			return;
		}
		Util::addScript(Application::APP_ID, 'files-action');
	}
}
