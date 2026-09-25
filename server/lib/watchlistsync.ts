import PlexTvAPI from '@server/api/plextv';
import { MediaStatus, MediaType } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import logger from '@server/logger';
import { Permission } from './permissions';
import { getSettings } from './settings';

class WatchlistSync {
  public async syncWatchlist() {
    const userRepository = getRepository(User);

    const { autoEnableWatchlistSync } = getSettings().main;
    const userQuery = userRepository
      .createQueryBuilder('user')
      .addSelect('user.plexToken')
      .leftJoinAndSelect('user.settings', 'settings')
      .where("user.plexToken != ''");

    if (autoEnableWatchlistSync) {
      userQuery.orWhere('user.userType = :userType', {
        userType: UserType.PLEX,
      });
    }
    const users = await userQuery.getMany();

    const ownerToken = users.find((user) => user.id === 1)?.plexToken;
    const ownerPlexTv =
      autoEnableWatchlistSync && ownerToken
        ? new PlexTvAPI(ownerToken)
        : undefined;

    for (const user of users) {
      await this.syncUserWatchlist(user, ownerPlexTv);
    }
  }

  private async syncUserWatchlist(user: User, ownerPlexTv?: PlexTvAPI) {
    const { autoEnableWatchlistSync } = getSettings().main;
    const watchlistSyncMovies =
      (user.settings?.watchlistSyncMovies ?? autoEnableWatchlistSync) &&
      user.hasPermission(
        [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_MOVIE],
        { type: 'or' }
      );
    const watchlistSyncTv =
      (user.settings?.watchlistSyncTv ?? autoEnableWatchlistSync) &&
      user.hasPermission(
        [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_TV],
        { type: 'or' }
      );

    if (!watchlistSyncMovies && !watchlistSyncTv) {
      return;
    }

    const items = user.plexToken
      ? (await new PlexTvAPI(user.plexToken).getWatchlist({ size: 20 })).items
      : autoEnableWatchlistSync &&
          user.userType === UserType.PLEX &&
          user.plexId &&
          ownerPlexTv
        ? await ownerPlexTv.getSharedWatchlist(user.plexId)
        : [];

    if (!items.length) {
      return;
    }

    const mediaItems = await Media.getRelatedMedia(
      user,
      items.map((i) => ({
        tmdbId: i.tmdbId,
        mediaType: i.type === 'show' ? MediaType.TV : MediaType.MOVIE,
      }))
    );

    const watchlistTmdbIds = items.map((i) => i.tmdbId);

    const requestRepository = getRepository(MediaRequest);
    const existingAutoRequests: MediaRequest[] =
      watchlistTmdbIds.length > 0
        ? await requestRepository
            .createQueryBuilder('request')
            .leftJoinAndSelect('request.media', 'media')
            .where('request.requestedBy = :userId', { userId: user.id })
            .andWhere('request.isAutoRequest = true')
            .andWhere('media.tmdbId IN (:...tmdbIds)', {
              tmdbIds: watchlistTmdbIds,
            })
            .getMany()
        : [];

    const autoRequestedTmdbIds = new Set(
      existingAutoRequests
        .filter(
          (r) => r.media != null && r.media.status !== MediaStatus.DELETED
        )
        .map((r) => `${r.media.mediaType}:${r.media.tmdbId}`)
    );

    const unavailableItems = items.filter((i) => {
      const itemMediaType = i.type === 'show' ? MediaType.TV : MediaType.MOVIE;

      return (
        !autoRequestedTmdbIds.has(`${itemMediaType}:${i.tmdbId}`) &&
        !mediaItems.find(
          (m) =>
            m.tmdbId === i.tmdbId &&
            m.mediaType === itemMediaType &&
            (m.status === MediaStatus.BLOCKLISTED ||
              (itemMediaType === MediaType.MOVIE &&
                m.status !== MediaStatus.UNKNOWN &&
                m.status !== MediaStatus.DELETED) ||
              (itemMediaType === MediaType.TV &&
                m.status === MediaStatus.AVAILABLE))
        )
      );
    });

    for (const mediaItem of unavailableItems) {
      try {
        if (
          (mediaItem.type === 'movie' && !watchlistSyncMovies) ||
          (mediaItem.type === 'show' && !watchlistSyncTv)
        ) {
          continue;
        }

        if (mediaItem.type === 'show' && !mediaItem.tvdbId) {
          throw new Error('Missing TVDB ID from Plex Metadata');
        }

        await MediaRequest.request(
          {
            mediaId: mediaItem.tmdbId,
            mediaType:
              mediaItem.type === 'show' ? MediaType.TV : MediaType.MOVIE,
            seasons: mediaItem.type === 'show' ? 'all' : undefined,
            tvdbId: mediaItem.tvdbId,
            is4k: false,
          },
          user,
          { isAutoRequest: true }
        );

        logger.info("Created media request from user's Plex Watchlist", {
          label: 'Watchlist Sync',
          userId: user.id,
          mediaTitle: mediaItem.title,
        });
      } catch (e) {
        if (!(e instanceof Error)) {
          continue;
        }

        switch (e.constructor) {
          // During watchlist sync, these errors aren't necessarily
          // a problem with Seerr. Since we are auto syncing these constantly, it's
          // possible they are unexpectedly at their quota limit, for example. So we'll
          // instead log these as debug messages.
          case RequestPermissionError:
          case DuplicateMediaRequestError:
          case QuotaRestrictedError:
          case NoSeasonsAvailableError:
            logger.debug('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
            break;
          // Blocklisted media should be silently ignored during watchlist sync to avoid spam
          case BlocklistedMediaError:
            break;
          default:
            logger.error('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
        }
      }
    }
  }
}

const watchlistSync = new WatchlistSync();

export default watchlistSync;
