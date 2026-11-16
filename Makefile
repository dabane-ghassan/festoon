UUID    := festoon@dabane-ghassan.github.io
VERSION := $(shell sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' extension/metadata.json)
DIST    := dist

.PHONY: all assets site install uninstall dist test clean

all: assets

# Redraw the logo and resynthesise the sounds from the scripts in tools/.
assets:
	python3 tools/make_brand.py
	python3 tools/make_sounds.py
	$(MAKE) site

# What the website needs from the app.
site:
	cp install.sh docs/install.sh
	cp extension/assets/pin.svg docs/assets/pin.svg
	touch docs/.nojekyll

install:
	sh install.sh

uninstall:
	sh install.sh --remove

# festoon.tar.gz: everything install.sh needs (what the curl installer downloads).
# festoon.shell-extension.zip: just the GNOME Shell part, for `gnome-extensions install`.
dist:
	rm -rf $(DIST) && mkdir -p $(DIST)/festoon
	cp -R extension bin packaging install.sh LICENSE README.md $(DIST)/festoon/
	rm -f $(DIST)/festoon/extension/schemas/gschemas.compiled
	tar -C $(DIST) -czf $(DIST)/festoon.tar.gz festoon
	glib-compile-schemas $(DIST)/festoon/extension/schemas
	cd $(DIST)/festoon/extension && zip -qr ../../festoon.shell-extension.zip .
	rm -rf $(DIST)/festoon

# End-to-end tests in a headless GNOME Shell (see tests/README.md).
test:
	python3 tests/run.py

clean:
	rm -rf $(DIST) extension/schemas/gschemas.compiled tests/out
