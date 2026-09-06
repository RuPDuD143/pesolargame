# Pesolar game — design spec

This is the original design document, kept here verbatim so it survives
between chat sessions (Claude has no memory of past conversations — this
file is the actual persistence mechanism). If a future session (with
Claude or otherwise) needs to know "how is this supposed to work," this
is the source of truth. Update it whenever the design changes, the same
way you'd update it if it lived in a wiki.

## Implementation status (as of this pass)

Implemented:
- Wallet login (WharfKit: Anchor/Cloud Wallet/Wombat), auto-login on return
- Register as worker (100 WAX / 10,000 PESOLAR) or spectate
- Energy/resting/wake flow
- Locations 0-5 (Crag Hollow → Amaurosis) with ore spawn tables, node_max
  budget math, strikes-to-deplete, respawn
- Pickaxe throw mechanic (200px max range, boomerang animation)
- Per-location energy_max gating (1/14/34/134/634/1334) enforced both by
  hiding/blocking waypoints client-side and rejecting the strike
  server-side
- Waypoints between locations (walk into one, no dropdown)
- Backpack icon + live inventory panel + mine → backpack fly animation
- 100px wall band per location (placeholder colors, not real art yet)

Not implemented yet (still just this spec, no code):
- Houses (plrimages, plrfrntrs, plrpos, houses tables), furniture
  placement/edit mode, doorways between house and work/friend's house
- Marketplace (location 6): sell/buy UI, 5x markup, buy orders
- Character/pickaxe/wall/floor *asset art* (asset_id → filename lookups) —
  currently flat colors instead of real sprites
- orders table / actual coin-for-ore selling flow

## Original spec (verbatim)

Contract name: pesolargame1
Contract tables:
-sysdata{treasury(int)}
-workers{name,energy_max(int)}
Contract Actions (what this game needs to use):
payoutearn{name,amount}
this contract already exists, this is just for reference.

Firebase SQL database tables:
workers: name(str),energy,lastrest(datetime),isresting(bool),coins(int)
sysdata: resources(int),mined_resources(int; increments by resource weight), lastupdated(datetime)
plrimages: name(str), char_id, floor_id, wall_id
plrfrntrs: id, furniture_id, owner, grid_x(int), grid_y(int), in_house(bool)
plrpos: name(str), location_id(int), grid_x(int), grid_y(int) [the grids only update when players close the website, this is where the player will spawn next time they open it.]
houses: house_id(int), owner, locked(bool)
furnitures: asset_id, filename(string; e.g. 'default.png'), name
walls: asset_id, filename(string; e.g. 'default.png'), name
floors: asset_id, filename(string; e.g. 'default.png'), name
characters: asset_id, filename(string; e.g. 'default.png'), name
ores: asset_id, filename(string; e.g. 'default.png'), name(str; Stone, Iron, Gold, Diamond, Platinum, Pesolarium)
pickaxes: asset_id, filename(string; e.g. 'default.png'), name
inventory: owner, asset_id, amount, classification, item_name

locations: location_id (int), name(str) [first rows: (0,"Crag Hollow"),(1,"Rustrock Cavern"),(2,"Aurum Depths"),(3,"Shardfall Abyss"),(4,"The Noble Chasm"),(5,"Amaurosis")]
orders: buyer, asset_id, classification(e.g. walls, ores, etc.), amount, cost
------
HTML:
black screen. have the player log in to their wallet first (use wharfkit to support wombat, mycloudwallet, and anchor). auto login when they already logged in the first time.
if they don't exist on the workers table(contract), give them the option to "register as a worker" for 100 wax/10k pesolar, or "spectate the mine"
if they spectate, they just walk around to look at things, no pickaxe to mine anything. they also have [GUEST] beside their nametag.
if they buy or they exist in the contract's workers table, check the SQL's worker's table if they already exist, if not. create a new row {accountname, CONT_workers[energy_max], 0, false}. then check the SQL workers table if their 'isresting' is true. if yes, show them a stopwatch clock that counts from 'lastrest' to today. they also see how much energy they currently have
(SQL_workers[energy] + floor((now - SQL_lastrest) / (CONT_workers[energy_max]/24 hours)) and clicking the "Wake up" button updates 'isresting' to false, their 'energy' updates as well. then transitions the blackscreen to split and slide vertically, like opening someone's eye.

they spawn in a house area, defaulted to theirs. 600x400 px big house floor area (filename, you know what and how to get it)(8x5 grid placement for furnitures; grid '1,1' is the bottom-left corner, always), 600x100 wall area (filename, you know what and how to get it). WASD for movement. doorway is right "under" the grids (4,1) and (5,1), and walking through treats it as "going out". places furnitures accordingly according to the plrfrntr grid x and y. if playercharacter steps through the doorway, movement is halted and locked with confirmation message "Where will you go?". two options, "To work" and "Visit a friend's home"(when this option is clicked, prompt them to type in that person's name). when entering their/another player's home, have them spawn in grid (4.5,1). every location change, ensure the playercharacter is halted and locked, fade to black, change location, set position, fade from black, unlock movement. as for furniture placement, they can edit it by pressing the "Enter edit mode" button on the bottom right corner of the screen, then their inventory menu pops out from the right side of a screen like a sidebar. there they can see the furnitures they have. drag and drop to grid, right click to remove from grid, drag to move from grid. pressing "save changes" updates database accordingly. also, the image loops, not stretch.

location id #0 - Crag Hollow - 2000x2000px room, asset_id for wall is 0 and floor is 1.
this is where guests spawn and where "work" is located. ores spawn here:
maximum resource per node(node_max): (SQL_sysdata[resources]-mined_resources)/100. (e.g. =30. so maximum ore is iron, since its more than 25, but less than 125.)
Fixed probability
60% - Stone: 1 coin; 3 strikes max for this type of ore in all locations; dont spawn any if more than node_max
25% - Iron: 5 coins; 15 strikes max for this type of ore in all locations; default to stone if more than node_max; dont spawn any if stone is more than node_max
10% - Gold: 25 coins; 75 strikes max for this type of ore in all locations; default to stone if more than node_max; dont spawn any if stone is more than node_max
3% - Diamond: 125 coins; 375 strikes max for this type of ore in all locations; default to stone if more than node_max; dont spawn any if stone is more than node_max
1.5% - Platinum: 625 coins; 1875 strikes max for this type of ore in all locations; default to stone if more than node_max; dont spawn any if stone is more than node_max
0.5% - Pesolarium: 3125 coins; 9375 strikes max for this type of ore in all locations; default to stone if more than node_max; dont spawn any if stone is more than node_max

mechanic only occurs in location id 0-5 they click on an area, a 50x50 image of a pickaxe appears from a character, to that area. it moves like mjolnir, flies, strikes, and returns to sender wherever they are. it moves at a maximum of 200 px from the character center. whoever hit it last gets the item, it also adds to the SQL_sysdata[mined_resources] (e.g. player1 mines a gold ore, their inventory table's item_name(gold)'s amount increments, and 25 gets added to SQL_sysdata[mined_resources])

location id #1 - Rustrock Cavern - 2000x2000px room, asset_id for wall is 2 and floor is 3.
ores spawn here:
maximum resource per node(node_max): (SQL_sysdata[resources]-mined_resources)/100. (e.g. =30. so maximum ore is iron, since its more than 25, but less than 125. minimum resource is iron, no stone should spawn as seen below)
Fixed probability
60.5% - Iron: 5 coins; dont spawn any if more than node_max
25% - Gold: 25 coins; default to iron if more than node_max; dont spawn any if iron is more than node_max
10% - Diamond: 125 coins; default to iron if more than node_max; dont spawn any if iron is more than node_max
3% - Platinum: 625 coins; default to iron if more than node_max; dont spawn any if iron is more than node_max
1.5% - Pesolarium: 3125 coins; default to iron if more than node_max; dont spawn any if iron is more than node_max

location id #2 - Aurum Depths - 2000x2000px room, asset_id for wall is 4 and floor is 5.
ores spawn here:
maximum resource per node(node_max): (SQL_sysdata[resources]-mined_resources)/100.
Fixed probability
62% - Gold: 25 coins; dont spawn any if more than node_max
25% - Diamond: 125 coins; default to gold if more than node_max; dont spawn any if gold is more than node_max
10% - Platinum: 625 coins; default to gold if more than node_max; dont spawn any if gold is more than node_max
3% - Pesolarium: 3125 coins; default to gold if more than node_max; dont spawn any if gold is more than node_max

location id #3 - Shardfall Abyss - 2000x2000px room, asset_id for wall is 6 and floor is 7.
ores spawn here:
maximum resource per node(node_max): (SQL_sysdata[resources]-mined_resources)/100.
Fixed probability
65% - Diamond: 125 coins; dont spawn any if more than node_max
25% - Platinum: 625 coins; default to diamond if more than node_max; dont spawn any if diamond is more than node_max
10% - Pesolarium: 3125 coins; default to diamond if more than node_max; dont spawn any if more than node_max

location id #4 - The Noble Chasm - 2000x2000px room, asset_id for wall is 8 and floor is 9.
ores spawn here:
maximum resource per node(node_max): (SQL_sysdata[resources]-mined_resources)/100.
Fixed probability
75% - Platinum: 625 coins; dont spawn any if more than node_max
25% - Pesolarium: 3125 coins; default to platinum if more than node_max; dont spawn any if more than node_max

location id #5 - Amaurosis - 2000x2000px room, asset_id for wall is 10 and floor is 11.
ores spawn here:
maximum resource per node(node_max): (SQL_sysdata[resources]-mined_resources)/100.
Fixed probability
100% - Pesolarium: 3125 coins; dont spawn any if more than node_max

-----

Location id #6 - Marketplace
there's a stall that buys whatever they mined for coins. two uis appear, one for inventory, where you can see the items you mined in a grid, it's grouped by item, and it stacks with a maximum stack of 1000 per grid cell. there are tabs located at the top to that UI to group the item types, "Ores", "Furniture", and "Characters". on the right side is the sell area with a label "Drag Items here to sell them", if they drag an item in a stack(>1 included in the drag), it prompts them to confirm how many they would like to sell out of those stack. there's also tabs at the right side of the ui, "Sell", and "Purchase" - where they buy those materials at a 5x markup, or create a buy order

-----

firebase project id: pesolargame

## Addendum — UI changes (this pass)

- Backpack icon, bottom-left. On a successful mine, an ore item appears
  (locally, client-side only) growing out from the node location, slides
  to the backpack icon, then shrinks out. It also reflects in the
  database (workers/{account}/inventory/{oreType}.amount — this part was
  already true before the animation existed). Clicking the backpack
  reveals what's been mined.
- Each location's wall is 100px tall (y-axis).
- Location access gates by CONT_workers[energy_max]:
  location 0: free for everyone
  location 1: energy_max >= 14
  location 2: energy_max >= 34
  location 3: energy_max >= 134
  location 4: energy_max >= 634
  location 5: energy_max >= 1334
- No location dropdown — replaced with walkways/waypoints you walk into.
