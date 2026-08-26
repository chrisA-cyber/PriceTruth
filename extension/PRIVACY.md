# PriceTruth browser extension privacy disclosure

Effective: 2026-08-25

The PriceTruth browser extension processes visible price text from supported
shopping pages in the browser to calculate an estimated all-in price. It does
not automatically transmit browsing history, page URLs, product details,
detected prices, or calculation results to PriceTruth or any third party.

The extension stores only the supported-site enable/disable preferences chosen
by the user. Those preferences are kept in Chrome extension local storage and
are not synchronized by PriceTruth.

The extension does not contain analytics, advertising identifiers, remote
code, or automatic network-request code. It does not sell or share user data.

The **Report detection** control opens the configured PriceTruth web app after a
user chooses it. Its URL includes the seller-adapter identifier, the classified
vertical, and the detected amount in integer cents so the feedback form can be
prepared. It does not include the shopping-page URL, and opening the form does
not submit feedback. Any information the user later chooses to submit is
governed by the privacy policy published at the deployed PriceTruth service.

Chrome's host-access notice is required because the extension must read visible
prices and place the local overlay on the supported seller pages. The `storage`
permission is used only for the settings described above.

The operator must publish the final service privacy-policy URL and support
contact in the Chrome Web Store listing before submission; those deployment
identities are intentionally not invented in source code.
