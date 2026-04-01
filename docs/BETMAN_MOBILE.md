# BETMAN Mobile

BETMAN Mobile is the mobile execution companion for the BETMAN platform.

## Stack
- Expo
- React Native
- React Navigation
- Expo Haptics
- Expo Notifications
- AsyncStorage

## Primary screens

### Bets / Races
- `src/screens/BetsScreen.tsx`
- country/meeting/race/runner state restoration
- deep-link recovery from tracked / Pulse flows
- silk fallbacks and stronger meeting matching

### Tracked
- `src/screens/TrackedScreen.tsx`
- tracked runner review
- `Open Race` action into exact race context

### Alerts
- `src/screens/AlertsScreen.tsx`
- Pulse alert surface
- quick filters
- open-race actions
- track/untrack actions

### Settings
- `src/screens/SettingsScreen.tsx`
- Pulse configuration on mobile
- web/mobile shared targeting and thresholds

## Product role
BETMAN Mobile is the fast-response companion for:
- Pulse monitoring
- tracked-runner follow-up
- race reopen workflows
- mobile continuity away from the desktop workspace
