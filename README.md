# Shared virtual office for AI agents

A browser-based office where AI workers run real terminal processes: Codex, Claude Code, OpenCode, Pi, or a shell. A Go server shares their terminals, office state, and presence across connected users.

Workers sit at their computers, take breaks, and approach the owner when they need input. The office includes customizable PC desktops, phone apps, a shared whiteboard, interactive blinds and lights, a coffee machine, and YouTube playback with TV casting. Outside, users can drive four vehicle types through a town with traffic, changing weather, and seasonal scenery.

## Running

Requires Go 1.26, Node.js, and npm. Install the agent CLIs you want to use and make them available on `PATH`.

```powershell
cd web
npm ci
npm run build
cd ..
go run . -workspace .
```

It binds `0.0.0.0:7317` and prints a LAN URL, so you can open the office from a
phone or another machine. Flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `-addr` | `0.0.0.0:7317` | listen address; use `127.0.0.1:7317` to keep it local-only |
| `-open` | `true` | open a browser on start |
| `-dev` | `false` | serve a rebuilt `web/dist` from disk |
| `-create` | `false` | allow new accounts from the sign-in screen |
| `-workspace` | your home directory | default working folder for new workers |
| `-https-addr` | empty | optional HTTPS listener for WebXR |
| `-tls-cert`, `-tls-key` | empty | certificate and key for the HTTPS listener |

Account creation is off unless you pass `-create`, so a server exposed to the LAN
does not accept new signups by default. The first account always works regardless,
otherwise a fresh server could never be set up. Each worker can still be given its
own folder in the hire panel, which overrides the default.

For frontend work, run `go run . -open=false -workspace .` from the root and `npm run dev`
from `web/`, then open `http://localhost:5173`. Vite proxies `/rpc` and `/ws`
to the Go server. `-dev` instead serves a rebuilt `web/dist` from disk.

## Accounts

The first password account becomes the owner, shown as admin in the office. Members
sign in with a username and password. Guests pick a name and knock; a member lets
them in from the door panel. The owner can assign nicknames, kick, ban, and unban.

Guests can walk, chat, view terminals and the whiteboard, and use the watercooler.
They cannot hire workers, start shells, edit the board, change room controls, run
the Conductor, or change provider credentials. These limits are enforced server-side.

## Controls

| Control | Action |
| --- | --- |
| `WASD`, `Shift`, `Space` | walk, run, jump |
| `E` or click an aimed object | interact, sit, use a switch, or operate the coffee machine |
| `Q` | hire at an available desk |
| `T` | open the aimed worker's terminal |
| `C` | open the aimed worker's computer as the owner |
| `B` | focus shared chat |
| `↑` | open or close the phone |
| `F` | pick up or put down a nearby movable object or coffee cup |
| `N`, `H` | place a sticky note or hang a picture |
| `G` | send the aimed worker home |
| `Alt` or `Ctrl`, `Esc` | free or release the captured mouse |

At the owner's desk, `E` sits first and opens the computer when already seated. Desktop icons snap to a grid, retain their positions, and fit without desktop scrolling. App windows can be moved and resized; personalization is in Settings. Physical laptop screens mirror their desktop and open windows, including live video.

Use the phone's Garage app to drive from town, or `E` beside a parked vehicle to enter it. While driving, `WASD` controls the car, `Space` brakes, `J` sounds the horn, and `E` exits. Phone apps also include YouTube, music, worker sessions, the whiteboard, weather, and office controls. Blinds can be opened or closed individually or together from the phone or PC.

At the coffee machine, `E` brews and picks up coffee; with a cup held, it drinks or throws the cup away near the waste bin. Saved workers can be resumed after a server restart.

## Data

State lives in `%USERPROFILE%\.agentoffice` (`~/.agentoffice` elsewhere), or the
directory set by `AGENTOFFICE_HOME`. It includes accounts, session cookies, provider
credentials, worker details, whiteboard strokes, room controls, and Conductor data.

Terminals are shared with approved participants, including guests; terminal output is not private between users.

## Asset licenses

Adapted scene models retain the upstream MIT notice in [web/public/models/LICENSE](web/public/models/LICENSE). The Windows ConPTY implementation retains its license in [third_party/charmbracelet-conpty/LICENSE](third_party/charmbracelet-conpty/LICENSE).
