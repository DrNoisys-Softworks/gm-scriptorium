![GM-Scriptorium: a lantern lights a page, GM notes stay dark](docs/images/banner.png)

GM-Scriptorium turns your campaign vault into a website your players can read. A vault is the
folder of markdown notes you keep for one campaign, laid out the way the
[gm-apprentice](https://github.com/AntTheLimey/gm-apprentice) project lays them out, and it opens in
Obsidian like any other folder of notes. See [what a vault needs](docs/using.md#what-you-need).
Since 0.5.0, GM-Scriptorium can also [make a new vault for you](docs/how-to/start-a-new-campaign.md).
Anything this page marks "Since 0.5.0" needs version 0.5.0 or later; `gm-scriptorium --version` shows yours.

By default GM-Scriptorium publishes only the pages your vault lists for players, and it cuts the
parts you mark for the GM. Before it publishes anything, it checks your notes for GM material and
for names you have withheld, then scans the site it built for those names again. A leak it finds
stops the build. A clean check is not clearance, though: read the site yourself before you share it,
and see [what the leak checks cannot see](docs/explanation/what-players-see.md#what-the-leak-checks-cannot-see).
Built for tabletop GMs. Free and open source.

[Download](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases) for Windows or Linux, or [see the sample campaign online](https://drnoisys-softworks.github.io/gm-scriptorium/)
and [what a leak check protects](https://drnoisys-softworks.github.io/gm-scriptorium/leak-demo.html).
To build it yourself, read the [sample campaign guide](examples/README.md) (`examples/the-long-lease`).

## How it works

1. **Point it at your vault.** `gm-scriptorium init` sets up a campaign at a terminal: point it at your vault, name it and
   pick a theme. Since 0.5.0, with no campaign yet, `gm-scriptorium serve --admin` runs the same setup in your browser. That
   setup asks five questions, or six if it makes a new vault for you, because then it also asks the game system.
2. **Check.** Pages are scanned for anything marked for the GM. Problems are listed before any build.
3. **Build and share.** You get a plain folder of web pages. Preview it in the admin panel, then
   host it anywhere.

## Get it

Download the single program for your system (no Node or npm needed) from the
[Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases) and run it from
wherever you keep tools. A Windows installer, with a Start menu shortcut and an uninstaller, is
coming in 0.5.0. Releases before 1.0 are not signed yet, so Windows SmartScreen will probably warn
you the first time you run one: click **More info**, then **Run anyway**. Signing starts at 1.0.
Installing a release, checking its signature and hash, and building a binary are in
[Install](docs/install.md).

Or build it from source (needs Node.js 22 or later):

```
git clone https://github.com/DrNoisys-Softworks/gm-scriptorium
cd gm-scriptorium && npm install
node bin/scriptorium.js --help
```

Replace `gm-scriptorium` with `node bin/scriptorium.js` in the commands below.

## Use it

```
gm-scriptorium
```
Run it with no command in a terminal, or double-click the program on Windows. If GM-Scriptorium has no settings file yet, it offers to run `gm-scriptorium init` for you, and the window waits for you to press Enter before it closes; otherwise it shows the list of commands. Since 0.5.0 it opens the admin panel in your browser instead, starting with setup when there is no campaign yet. A copy you installed with Setup runs in the background with an icon in the system tray, so closing the browser or the terminal doesn't stop it; use the icon's Quit. A copy you run as a single file keeps its window, and closing that window stops it.

```
gm-scriptorium init
```
Set up a campaign: point it at your vault, name it and pick a theme.

```
gm-scriptorium check my-campaign
```
Read-only check of your pages, links and leaks. It writes nothing.

```
gm-scriptorium build my-campaign
```
Run the checks again and build the player site. A leak stops the build.

```
gm-scriptorium serve my-campaign
```
Preview the site on your own computer before it goes anywhere.

```
gm-scriptorium serve my-campaign --admin
```
Open the local admin panel to change the theme, images, vocabulary, title and tagline, run the checks, preview the site privately, edit your vault's settings page and see whether remote access is on. Since 0.5.0 it can also add a campaign, switch between campaigns and tell you when a newer version is out.

## Learn more

The [documentation index](docs/README.md) lists every page. The pages for GMs are in four groups:

- **Tutorial:** [The Long Lease: a sample campaign](examples/README.md), to copy, build and serve
  before you point the tool at your own vault.
- **How-to guides:** [Install, update and build from source](docs/install.md),
  [Using GM-Scriptorium](docs/using.md), [Start a new campaign](docs/how-to/start-a-new-campaign.md),
  [Keep GM-only notes off the player site](docs/how-to/hide-gm-content.md),
  [Trying it safely](docs/trying-it-safely.md), [Backing up your vault](docs/backing-up-your-vault.md),
  [Remote access](docs/remote-access.md) and [Troubleshooting](docs/how-to/troubleshooting.md),
  among others.
- **Reference:** every command, flag, setting and message, starting with
  [the command line](docs/reference/command-line.md).
- **Explanation:** [How GM-Scriptorium decides what players see](docs/explanation/what-players-see.md)
  and [Why, and how this relates to gm-apprentice](docs/about.md).

[Privacy](docs/privacy.md), in short: no telemetry and no analytics, and the admin panel stays on
your computer unless you turn on remote access. `update` talks only to GitHub. Since 0.5.0 it needs
no GitHub account, and the panel's update notice can be turned off. Earlier versions fetch updates
through the GitHub CLI (`gh`) and need it signed in.

GM-Scriptorium wraps the [gm-apprentice](https://github.com/AntTheLimey/gm-apprentice) site
generator, and all credit for the vault-to-site generation goes to that project.

## Licence and contributing

MIT. See [`LICENSE`](LICENSE). Contributions are welcome: start with
[`CONTRIBUTING.md`](CONTRIBUTING.md).
