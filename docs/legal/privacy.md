# Privacy policy publication inputs

> **INTERNAL PRELAUNCH WORKSHEET — NOT A PRIVACY POLICY**
>
> Do not publish, link to, or present this file as terms offered to users. It records the
> operator decisions and counsel review required before a real privacy policy can be issued.
> It deliberately contains no assumed company, address, jurisdiction, or contact details.

**Publication status:** Blocked pending operator input and legal review

**Worksheet revision:** August 25, 2026

## Fail-closed launch gate

Any public feature that creates an account, stores a personal identifier, sends a notification,
or accepts payment must remain disabled until all of the following are true:

- The legal operator name and service address are confirmed.
- A monitored, private privacy/support contact is operational.
- Launch regions and the operator's role in each region are decided.
- Counsel has approved the public policy and its effective date.
- The approved policy accurately matches the deployed configuration and subprocessors.
- Retention, access, correction, export, deletion, and appeal workflows have been tested.
- Material policy changes and consent renewal have named owners and procedures.

Missing information is a launch blocker. Do not substitute a product name, a fake domain,
an example address, or an assumed jurisdiction.

## Implementation inventory to validate

Before drafting, the operator and engineering owner must validate the deployed data map. The
current application can process the following categories, depending on enabled features and
configuration:

- Account email, verification state, session metadata, and passwordless sign-in tokens.
- Preferences such as email alerts, weekly digests, and timezone.
- Saved products, watchlist records, price-alert thresholds, and notification status.
- API-key metadata and usage records; raw keys are shown only during issuance or rotation.
- Billing account, subscription, entitlement, and transaction metadata supplied by the payment
  provider. Card details are handled by the payment provider, not the application.
- Export and deletion requests, operational security records, and abuse-prevention metadata.
- Search terms and product URLs submitted for analysis, including data sent to enabled price
  providers when necessary to answer a request.

For every category, record the exact fields, purpose, legal basis where applicable, source,
recipients, storage location, encryption controls, retention period, deletion behavior, backup
behavior, and whether it crosses a national border. Confirm the inventory against the deployed
database schema, email service, billing provider, hosting platform, logs, analytics settings,
and live price-provider configuration. Do not rely on this worksheet as the inventory itself.

## Operator decisions required

The public policy cannot be drafted responsibly until the operator supplies and counsel reviews:

- Legal operator identity, physical or service address, and privacy contact channel.
- Intended audience, minimum age, launch territories, and any excluded territories.
- Controller, business, processor, or service-provider roles that apply.
- The lawful basis and user-facing purpose for each processing activity.
- Whether optional analytics, cookies, advertising, affiliate tracking, or profiling are enabled.
- The complete subprocessor list, locations, transfer mechanisms, and change-notice process.
- Concrete retention periods and backup-deletion limits for every data category.
- Identity-verification steps and response deadlines for privacy-rights requests.
- Complaint, regulator, representative, and data-protection-officer details where required.
- Incident-notification ownership and region-specific notification timelines.
- Sale, sharing, targeted-advertising, and sensitive-data positions for applicable US states.
- Consent records, unsubscribe behavior, and suppression-list retention for email notifications.

## Required workflow evidence

The launch approver must retain evidence that these paths work end to end:

- Users can see the policy before supplying personal information or paying.
- Account export contains the data categories the policy promises to provide.
- Account deletion removes or de-identifies active records and documents backup handling.
- Notification consent is verified and every message supports an effective unsubscribe path.
- Revoked sessions and API keys stop working promptly.
- Preference changes and alert deletion persist after a new session.
- Support can authenticate a requester without collecting excessive additional data.
- The deployed cookie and network behavior matches the published disclosures.

## Drafting and approval handoff

Counsel should create a separate, publishable policy from the completed data inventory and
operator decisions. The release record must identify the approved document version, reviewer,
approval date, deployed URL, and configuration snapshot. This worksheet stays internal and must
never be used as a substitute for that approved policy.
