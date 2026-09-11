<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
		// The user's shown-on-map selection (see StateController).
		['name' => 'state#get', 'url' => '/state', 'verb' => 'GET'],
		['name' => 'state#set', 'url' => '/state', 'verb' => 'PUT'],
	],
];
