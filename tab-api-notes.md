# TAB NZ Affiliates API (api.tab.co.nz/affiliates/v1) — notes

## Date params
- `date_from` / `date_to` accept helper words like `today` (YYYY-MM-DD also works).
- Full ISO timestamps (e.g., 2026-02-28T00:00:00Z) are rejected on meetings endpoint.

## Confirmed endpoints
### Meetings
`GET /affiliates/v1/racing/meetings?date_from=today&date_to=today&country=<NZ|AUS|HK>&type=T&limit=200&offset=0`
- Returns meetings + races[] with `id` = race event id.

### Event details (race + runners + odds + form + flucs)
`GET /affiliates/v1/racing/events/<event_id>`
Optional toggles observed:
- `with_money_tracker=true`
- `with_big_bets=true`
- `with_biggest_bet=true`
- `with_tote_trends_data=true`
- `will_pays=true` (appears ignored/returned false in params in our calls)
- `present_overlay=true|false`
- `bet_type_filter=`
- `bets_limit=10`

### Races by channel
`GET /affiliates/v1/racing/races?channel=<Trackside1|Trackside2|Live1|Live2|NoVideos>&type=T&date=today`

## HK
- `country=HK` on meetings can return empty list if no meeting in-window.

## Next to implement
- Build a puller that:
  1) queries meetings for NZ/AUS/HK
  2) filters meetings by name (e.g., Randwick/Flemington) or by country
  3) pulls `/racing/events/<id>` for upcoming races
  4) persists raw JSON + a normalized runners table
