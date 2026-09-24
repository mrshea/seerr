---
title: Watchlist Auto Request
description: Learn how to use the Plex Watchlist Auto Request feature
sidebar_position: 1
---

# Watchlist Auto Request

The Plex Watchlist Auto Request feature allows Seerr to automatically create requests for media items you add to your Plex Watchlist. Simply add content to your Plex Watchlist, and Seerr will automatically request it for you.

:::info
This feature is only available for Plex users. Local users cannot use the Watchlist Auto Request feature.
:::

## Prerequisites

- You must either have signed into Seerr with Plex or have been imported by your administrator with a watchlist shared with the server owner
- Your administrator must have granted you the necessary permissions
- Your Plex account must have access to the Plex server configured in Seerr

## Permission System

The Watchlist Auto Request feature uses a two-tier permission system:

### Administrator Permissions (Required)
Your administrator must grant you these permissions in your user profile:
- **Auto-Request** (master permission)
- **Auto-Request Movies** (for movie auto-requests)
- **Auto-Request Series** (for TV series auto-requests)

### User Preferences
The following options control auto-request in your profile settings:
- **Auto-Request Movies** toggle
- **Auto-Request Series** toggle

:::info
Profile options are off by default. Administrators can enable defaults for users who have not saved their own preferences under **Settings > Users**, so those users do not need to turn them on individually. Auto-request permissions are still required. Imported users can skip signing into Seerr if their watchlist is shared with the server owner. Users can change their own preferences at any time.
:::

## How to Enable

### Step 1: Check Your Permissions
Contact your administrator to verify you have been granted:
- `Auto-Request` permission
- `Auto-Request Movies` and/or `Auto-Request Series` permissions

### Step 2: Activate the Feature (Unless Enabled by Your Administrator)
If your administrator enabled the corresponding defaults and you have not saved a different preference, you can skip this step.

1. Go to your user profile settings
2. Navigate to the "General" section
3. Find the "Auto-Request" options
4. Adjust the toggles for:
   - **Auto-Request Movies** - to automatically request movies from your watchlist
   - **Auto-Request Series** - to automatically request TV series from your watchlist

### Step 3: Start Using
- Add movies and TV shows to your Plex Watchlist
- Seerr will automatically create requests for new items
- You'll receive notifications when items are auto-requested

## How It Works

Once properly configured, Seerr will:

1. Periodically checks your Plex Watchlist for new items
2. Verify if the content already exists in your media libraries
3. Automatically submits requests for new items that aren't already available
4. Only requests content types you have permissions for
5. Notifiy you when auto-requests are created

:::info Content Limitations
Auto-request only works for standard quality content. 4K content must be requested manually if you have 4K permissions.
:::

## For Administrators

### Granting Permissions
1. Navigate to **Users** > **[Select User]** > **Permissions**
2. Enable the required permissions:
   - **Auto-Request** (master toggle)
   - **Auto-Request Movies** (for movie auto-requests)
   - **Auto-Request Series** (for TV series auto-requests)
3. Optionally enable **Auto-Approve** permissions for automatic approval

### Default Permissions
- Go to **Settings** > **Users** > **Default Permissions**
- Configure auto-request permissions for new users
- To skip individual profile activation, enable **Auto-Request Movies by Default** and/or **Auto-Request Series by Default** on the same page
- Both options are off by default and apply to new and existing users whose corresponding profile preferences are unset
- Explicitly saved user preferences take precedence over these defaults
- Users still need the corresponding auto-request permissions

### Imported Users Without a Seerr Sign-In

1. Ensure the user has library access to the Plex server configured in Seerr
2. Become Plex friends with the user using the Plex account linked to the Seerr owner
3. Have the user make their watchlist visible to friends in their [Plex profile privacy settings](https://support.plex.tv/articles/profile/)
4. Import the user from Plex on the **Users** page
5. Grant the user auto-request permissions and enable the corresponding defaults under **Settings > Users**

Seerr uses the owner's Plex token to read these shared watchlists and creates requests as the imported user. The user does not need to sign into Seerr, and Seerr does not need to be accessible outside your local network. Library access alone does not grant access to a user's watchlist. Private watchlists are skipped.

Users who have already signed in continue to use their own Plex tokens. User preferences, request permissions, quotas, and approval requirements apply in both cases.

## Limitations

- Local users cannot use this feature
- 4K content requires manual requests
- Users without a Plex sign-in must be imported and share their watchlist with the server owner
- Respects user request limits and quotas
- Won't request content already in your libraries
