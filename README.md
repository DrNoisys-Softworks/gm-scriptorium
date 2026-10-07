# GM-Scriptorium

Turn your Obsidian-style campaign vault into a player-safe website, with checks that keep your
GM-only notes off it. Built for tabletop GMs. Free and open source.

## What it does

- **Keeps secrets secret.** Leak checks look for GM-only names and notes in your vault and in the
  built site, and refuse to publish if one gets through.
- **Looks the part.** Built-in themes, image slots and a vocabulary pack for each campaign.
- **Has a local admin panel.** Pick a theme and edit your tagline, with a live preview, on your
  own computer only.
- **Is one portable program.** Releases are a single executable, with no Node or npm needed.
- **Is free and open source** under the MIT licence.

## Get it

There is no public release yet. The first one is coming, and it will appear on the
[Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). Until then you
can build it from source (needs Node.js 22 or later):

```
git clone https://github.com/DrNoisys-Softworks/gm-scriptorium
cd gm-scriptorium && npm install
node bin/scriptorium.js --help
```

Replace `gm-scriptorium` with `node bin/scriptorium.js` in the commands below. Installing a release,
verifying it and building a binary are in [Install](docs/install.md).

## Use it

Try it first on the sample campaign in [`examples/the-long-lease`](examples/README.md).

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
Open the local admin panel for themes, image slots and your tagline.

## Learn more

- [Using GM-Scriptorium](docs/using.md): what a vault needs, every command, and the leak checks.
- [Install, update and build from source](docs/install.md)
- [Trying it beside a real campaign](docs/trying-it-safely.md)
- [Backing up your vault](docs/backing-up-your-vault.md)
- [Privacy](docs/privacy.md): no telemetry, no analytics, and the admin panel stays on your computer unless you turn on remote access.
- [Why, and how this relates to gm-apprentice](docs/about.md)
- [All documentation](docs/README.md)

GM-Scriptorium wraps the [gm-apprentice](https://github.com/AntTheLimey/gm-apprentice) site
generator, and all credit for the vault-to-site generation goes to that project.

## Licence and contributing

MIT. See [`LICENSE`](LICENSE). Contributions are welcome: start with
[`CONTRIBUTING.md`](CONTRIBUTING.md).
