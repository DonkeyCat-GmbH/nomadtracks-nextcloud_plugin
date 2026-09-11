<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 DonkeyCat GmbH <office@donkeycat.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * @var \OCP\IL10N $l
 * @var array $_
 */
?>
<div id="nomadtracks-app">
	<aside id="nomadtracks-sidebar">
		<div id="nomadtracks-tree" aria-label="<?php p($l->t('NomadTracks library')); ?>">
			<div class="nt-loading"><?php p($l->t('Loading library …')); ?></div>
		</div>
		<div id="nomadtracks-sidebar-footer" hidden>
			<span id="nomadtracks-track-count"></span>
			<span class="nt-hint">
				<?php p($l->t('Tick a track to draw it on the map.')); ?>
			</span>
			<button id="nomadtracks-summary" class="nt-button" type="button" hidden></button>
		</div>
	</aside>
	<div id="nomadtracks-main">
		<div id="nomadtracks-map"></div>
		<div id="nomadtracks-empty" class="nt-empty" hidden>
			<h2><?php p($l->t('No NomadTracks library found')); ?></h2>
			<p>
				<?php p($l->t('There is no "NomadTracks" folder in your files yet.')); ?>
			</p>
			<p>
				<?php p($l->t('Connect the NomadTracks mobile app to this Nextcloud account and run a sync — the app will create the folder and this page will show your tracks and POIs on the map.')); ?>
			</p>
		</div>
		<div id="nomadtracks-toast" hidden></div>
	</div>
	<aside id="nomadtracks-details" aria-label="<?php p($l->t('Details')); ?>" hidden>
		<div id="nomadtracks-details-header">
			<h2 id="nomadtracks-details-title"></h2>
			<button id="nomadtracks-details-close" class="nt-close"
				type="button" title="<?php p($l->t('Close details')); ?>"
				aria-label="<?php p($l->t('Close details')); ?>">×</button>
		</div>
		<div id="nomadtracks-details-body"></div>
	</aside>
</div>
