# Requirements Document

## Introduction

The **Community Lifecycle Orchestration and Intelligence System (CLOIS)** is a full-stack, multi-tenant SaaS platform that helps communities and event organizers manage the complete lifecycle of their activities — from initial planning and coordination through execution, automation, monitoring, analytics, and post-event intelligence.

CLOIS targets community managers, event organizers, volunteer coordinators, and community members across domains such as professional associations, non-profits, educational institutions, civic groups, and corporate communities.

The system is built on a React + TypeScript + Tailwind CSS frontend backed by AWS Serverless infrastructure (Lambda, API Gateway, DynamoDB, S3, Cognito, EventBridge, SQS/SNS, Step Functions) with AI capabilities powered by Amazon Bedrock.

### MVP Scope

The MVP focuses on the seven most critical user journeys:

1. **Org onboarding & member management** — create a tenant, invite members, assign roles
2. **Event creation & scheduling** — plan events with capacity, venues, and tickets
3. **RSVP & ticketing** — members register and receive confirmations
4. **Notifications & announcements** — targeted emails/in-app messages
5. **Check-in & real-time operations** — QR-code check-in and live attendance tracking
6. **Basic analytics** — post-event attendance reports and engagement summaries
7. **AI assistance** — smart scheduling suggestions and AI-generated event descriptions

Future phases will address payment processing, full calendar integrations, volunteer coordination, recurring-event automation, advanced AI analytics, and third-party social-sharing integrations.

---

## Glossary

- **CLOIS**: Community Lifecycle Orchestration and Intelligence System — the platform described in this document.
- **Organization**: A top-level multi-tenant entity representing a community, club, association, or company team. Each Organization is isolated from all others.
- **Tenant**: Synonym for Organization in multi-tenancy context.
- **Member**: A user who belongs to at least one Organization.
- **Owner**: The Member who created an Organization; holds the highest privilege level.
- **Admin**: A Member granted administrative rights within an Organization by an Owner.
- **Organizer**: A Member granted the right to create and manage Events within an Organization.
- **Attendee**: A Member (or guest) who has registered for an Event.
- **Guest**: A non-Member external person who registers for a public Event without a full account.
- **Event**: A scheduled activity managed within an Organization, with a defined start time, end time, location, and capacity.
- **Event_Lifecycle**: The sequence of states an Event passes through: Draft → Published → Open → In_Progress → Completed → Archived (or Cancelled).
- **Ticket**: A reservation record associating an Attendee with an Event, including a unique QR code.
- **Venue**: A physical or virtual location associated with an Event, including capacity metadata.
- **RSVP**: The act of a Member or Guest registering for an Event.
- **Check_In**: The act of scanning or manually confirming an Attendee's presence at an In_Progress Event.
- **Announcement**: A broadcast message sent from an Organizer or Admin to a defined audience within an Organization.
- **Notification**: A system-generated message sent to a Member in response to a platform event (e.g., RSVP confirmation, reminder).
- **Workflow**: An automated sequence of actions triggered by a platform event, implemented via AWS Step Functions.
- **Role**: A named permission set assigned to a Member within an Organization (Owner, Admin, Organizer, Member).
- **Audit_Log**: An immutable, append-only record of security-relevant and data-mutation operations.
- **Dashboard**: A real-time or near-real-time visual display of key metrics for an Organizer or Admin.
- **AI_Assistant**: The Amazon Bedrock-powered service within CLOIS that provides generative and predictive capabilities.
- **Sentiment_Score**: A numeric value in the range [-1.0, 1.0] representing the overall positive or negative tone of textual feedback.
- **Analytics_Report**: A structured data artifact generated after an Event is completed, summarizing attendance, engagement, and feedback metrics.
- **API_Gateway**: The AWS API Gateway instance that routes HTTP requests to Lambda functions.
- **Cognito_Pool**: The AWS Cognito User Pool that manages authentication and identity for CLOIS.
- **EventBridge_Bus**: The AWS EventBridge event bus used for internal domain event routing.
- **DynamoDB_Table**: Any AWS DynamoDB table used by CLOIS for persistent storage.
- **S3_Bucket**: Any AWS S3 bucket used by CLOIS for asset storage (images, exports, reports).
- **SQS_Queue**: An AWS SQS queue used for decoupled asynchronous processing.
- **Step_Functions_Machine**: An AWS Step Functions state machine orchestrating multi-step Workflows.

---

## Requirements

---

### Requirement 1: User Registration and Authentication

**User Story:** As a new user, I want to register for a CLOIS account and authenticate securely, so that I can access the platform and join or create Organizations.

#### Acceptance Criteria

1. THE Cognito_Pool SHALL support email-and-password registration with email verification before account activation.
2. WHEN a user submits a registration form with a valid email and a password of at least 12 characters containing at least one uppercase letter, one lowercase letter, one digit, and one special character, THE Cognito_Pool SHALL create an unverified account and send a verification email within 60 seconds.
3. WHEN a user clicks the verification link within 24 hours of receipt, THE Cognito_Pool SHALL activate the account and redirect the user to the platform login page.
4. IF a user clicks a verification link that has expired (older than 24 hours), THEN THE CLOIS SHALL display an error page indicating the link has expired and provide an option to resend the verification email, and SHALL NOT activate the account.
5. IF a user submits a registration form with an email address already associated with an existing account, THEN THE API_Gateway SHALL return HTTP 409 with an error message indicating the email is already registered and SHALL NOT create a duplicate account.
6. WHEN a verified user submits valid credentials, THE Cognito_Pool SHALL issue a JWT access token with a 1-hour expiry and a refresh token with a 30-day expiry.
7. WHEN a user presents a valid refresh token that is within its 30-day expiry window, THE Cognito_Pool SHALL issue a new access token without requiring re-entry of credentials.
8. IF a user presents an expired or invalid refresh token, THEN THE Cognito_Pool SHALL return an authentication error and SHALL NOT issue a new access token.
9. WHEN a user requests a password reset, THE Cognito_Pool SHALL invalidate any previously issued unexpired reset links for that account and send a new one-time reset link to the registered email address that expires after 15 minutes.
10. IF a user attempts to use an expired or already-used password reset link, THEN THE CLOIS SHALL display an error indicating the link is no longer valid and SHALL NOT allow the password to be changed.
11. IF a user presents an expired or invalid access token to the API_Gateway, THEN THE API_Gateway SHALL return HTTP 401 and SHALL NOT process the request.
12. THE Cognito_Pool SHALL support Multi-Factor Authentication (MFA) via TOTP for any Member who enables it in their account settings.
13. WHILE MFA is enabled for a Member, THE Cognito_Pool SHALL require a valid TOTP code on every authentication attempt after password validation.
14. IF a Member submits 5 consecutive incorrect TOTP codes during a single authentication session, THEN THE Cognito_Pool SHALL lock the authentication session, require the Member to restart the login flow, and record the lockout in the Audit_Log.

---

### Requirement 2: Organization Creation and Multi-Tenant Isolation

**User Story:** As a community leader, I want to create an Organization, so that I can manage my community's events and members in a dedicated, isolated workspace.

#### Acceptance Criteria

1. WHEN an authenticated Member submits a valid Organization creation request with a name (3–100 characters) and a slug (3–63 characters, lowercase alphanumeric and hyphens only), THE CLOIS SHALL perform a case-insensitive uniqueness check on both name and slug, create a new Organization if both are unique, assign the requesting Member the Owner role, and return the Organization record within 3 seconds.
2. IF a Member submits an Organization creation request with a name or slug that duplicates an existing Organization (case-insensitive), THEN THE CLOIS SHALL return an error indicating which field is duplicated and SHALL NOT create the Organization.
3. THE CLOIS SHALL enforce tenant isolation so that Members of one Organization cannot read, write, or enumerate another Organization's Members, roles, Events, Tickets, or Audit_Log entries through any API endpoint.
4. WHEN an Owner deactivates an Organization, THE CLOIS SHALL immediately set the Organization status to Deactivated and revoke all active Member sessions scoped to that Organization.
5. THE CLOIS SHALL retain all data for a deactivated Organization for a minimum of 90 days before permanent deletion.
6. THE CLOIS SHALL allow a single Member to belong to up to 50 Organizations simultaneously, each with independent role assignments.
7. IF an Owner attempts to transfer ownership to a Member who is not an existing Member of the Organization, THEN THE CLOIS SHALL return an error indicating the target is not a Member and SHALL NOT perform the transfer.
8. WHEN an Owner transfers ownership to an existing Member of the Organization, THE CLOIS SHALL demote the previous Owner to Admin, promote the target Member to Owner, and record the transfer in the Audit_Log including the previous Owner ID, new Owner ID, and timestamp.

---

### Requirement 3: Member Invitation and Role Management

**User Story:** As an Organization Admin, I want to invite users to join my Organization and assign them roles, so that I can build a managed team with appropriate access levels.

#### Acceptance Criteria

1. WHEN an Admin or Owner submits an invitation for an email address with a specified Role (Admin, Organizer, or Member), THE CLOIS SHALL send an invitation email containing a unique acceptance link that expires after 72 hours.
2. IF an Admin or Owner submits an invitation for an email address that already belongs to an active Member of the Organization, THEN THE CLOIS SHALL return an error indicating the Member already belongs to the Organization and SHALL NOT send a duplicate invitation.
3. WHEN an invited user accepts the invitation link within the expiry window, THE CLOIS SHALL add the user to the Organization with the specified Role and record the membership in the Audit_Log.
4. IF an invited user accepts an invitation link after it has expired, THEN THE CLOIS SHALL return an error page indicating the link has expired and SHALL NOT add the user to the Organization.
5. IF an invited user attempts to use an invitation link that has already been accepted, THEN THE CLOIS SHALL return an error page indicating the link has already been used and SHALL NOT add the user to the Organization again.
6. WHEN an Admin or Owner changes a Member's Role within an Organization, THE CLOIS SHALL apply the new permissions within 2 seconds and record the change in the Audit_Log.
7. THE CLOIS SHALL enforce that an Organization always retains at least one Owner; IF an Admin or Owner attempts to remove or demote the sole Owner, THEN THE CLOIS SHALL return an error indicating the Organization must retain at least one Owner and SHALL NOT perform the role change.
8. WHEN an Admin or Owner removes a Member from an Organization, THE CLOIS SHALL revoke the Member's access to all Organization resources and cancel any pending Tickets held by that Member for upcoming Events within the Organization.
9. THE CLOIS SHALL support bulk invitation upload via a CSV file containing up to 500 rows, where each row contains an email address and a designated Role (Admin, Organizer, or Member); a valid entry is defined as a row with a syntactically valid email address and a recognized Role value.
10. IF an Admin uploads a CSV file containing more than 500 rows, THEN THE CLOIS SHALL reject the upload with an error indicating the row limit and SHALL NOT process any invitations from that file.
11. WHEN a bulk invitation CSV is processed, THE CLOIS SHALL send invitations to all valid entries, record each skipped entry with its reason (invalid email, unrecognized role, or duplicate existing member), and return a summary report to the requesting Admin within 60 seconds of upload submission.

---

### Requirement 4: Event Creation and Lifecycle Management

**User Story:** As an Organizer, I want to create and manage events through their full lifecycle, so that I can plan, publish, run, and archive community activities in a structured way.

#### Acceptance Criteria

1. WHEN an Organizer or Admin submits an Event creation request with all required fields present and valid, THE CLOIS SHALL create the Event in Draft state and return the Event record including a system-generated unique Event ID within 3 seconds.
2. THE CLOIS SHALL require the following fields for Event creation: title (1–200 characters), start datetime (UTC ISO 8601), end datetime (UTC ISO 8601), timezone identifier (IANA timezone string), and capacity (integer 1–100,000).
3. IF an Organizer submits an Event creation request where the end datetime is not strictly after the start datetime, THEN THE CLOIS SHALL return a validation error describing the datetime constraint and SHALL NOT create the Event.
4. WHEN an Organizer publishes an Event (transitions from Draft to Published), THE CLOIS SHALL validate that all required fields are populated and non-empty; IF validation fails, THEN THE CLOIS SHALL return an error listing the missing fields and SHALL NOT transition the Event out of Draft state.
5. WHEN an Organizer successfully publishes an Event, THE CLOIS SHALL set the Event status to Published and emit a domain event to the EventBridge_Bus within 3 seconds.
6. IF an Organizer or Admin attempts to transition an Event to a state that is not a valid next state in the Event_Lifecycle (e.g., Draft → Completed, Published → Draft), THEN THE CLOIS SHALL return an error indicating the transition is not permitted and SHALL NOT change the Event state.
7. WHEN the current UTC time reaches an Event's start datetime and the Event is in Published or Open state, THE CLOIS SHALL automatically transition the Event to In_Progress state via an EventBridge_Bus scheduled rule.
8. WHEN the current UTC time reaches an Event's end datetime and the Event is in In_Progress state, THE CLOIS SHALL automatically transition the Event to Completed state and trigger the post-event Analytics_Report generation Workflow.
9. WHEN an Organizer cancels an Event that is in Published, Open, or In_Progress state, THE CLOIS SHALL transition the Event to Cancelled state, void all associated Tickets, and notify all Attendees via the Notification system within 5 minutes.
10. THE CLOIS SHALL support Events with both physical and virtual (URL-based) venues; virtual Events SHALL store the meeting URL and SHALL NOT require a physical address.
11. WHERE recurring events are configured (future phase), THE CLOIS SHALL generate individual Event instances per occurrence with independent lifecycle states.
12. THE CLOIS SHALL retain Completed and Cancelled Events indefinitely in read-only Archived state for historical reporting.

---

### Requirement 5: Venue and Resource Management

**User Story:** As an Organizer, I want to define and reuse venues with capacity metadata, so that I can avoid overbooking and streamline event setup.

#### Acceptance Criteria

1. WHEN an Admin or Organizer creates a Venue record within an Organization, THE CLOIS SHALL store the name (1–200 characters), address (1–500 characters), capacity (integer 1–999,999), and optional amenities list (up to 50 items, each up to 100 characters), and return the Venue ID within 3 seconds.
2. IF an Admin or Organizer submits a Venue creation request with a capacity outside the range 1–999,999, THEN THE CLOIS SHALL return a validation error specifying the valid range and SHALL NOT create the Venue.
3. WHEN an Organizer associates a Venue with an Event, THE CLOIS SHALL default the Event capacity to the Venue's defined capacity while allowing the Organizer to set a lower value (minimum 1).
4. IF an Organizer attempts to set an Event capacity greater than the associated Venue's defined capacity, THEN THE CLOIS SHALL display a warning indicating the requested capacity exceeds the Venue capacity and SHALL require a distinct explicit override confirmation action before saving.
5. WHILE an Event is in Published or Open state and uses a Venue, IF an Admin or Organizer attempts to delete that Venue record, THEN THE CLOIS SHALL return an error message listing the active Events using the Venue and SHALL NOT delete the Venue.
6. THE CLOIS SHALL allow Venues to be shared and reused across multiple Events within the same Organization.

---

### Requirement 6: Ticketing and RSVP

**User Story:** As a community Member, I want to register for an event and receive a ticket, so that I can confirm my attendance and gain entry at check-in.

#### Acceptance Criteria

1. WHEN an authenticated Member or Guest submits an RSVP for an Event in Published or Open state, THE CLOIS SHALL create a Ticket record and assign a unique UUID-based ticket code within 5 seconds.
2. WHEN a Ticket record is created, THE CLOIS SHALL generate a QR code image encoding the ticket code, store it in the S3_Bucket, and return the Ticket record within 5 seconds.
3. IF a Member attempts to RSVP for an Event for which the Member already holds an active Ticket, THEN THE CLOIS SHALL return an error indicating the Member already has a registration for this Event and SHALL NOT create a duplicate Ticket.
4. IF a Guest attempts to RSVP for an Event using an email address that already has an active Ticket for that Event, THEN THE CLOIS SHALL return an error indicating the email address already has a registration and SHALL NOT create a duplicate guest Ticket.
5. WHEN an Event reaches its maximum capacity (confirmed Tickets equals Event capacity), THE CLOIS SHALL automatically transition the Event to Open (waitlist) state and SHALL NOT create new confirmed Tickets; subsequent RSVPs SHALL be added to a waitlist.
6. WHEN the waitlist for an Event reaches 100 entries, THE CLOIS SHALL reject further waitlist registrations with an error indicating the waitlist is full.
7. WHEN a confirmed Ticket is cancelled by its holder and a waitlist exists, THE CLOIS SHALL promote the first waitlisted RSVP to a confirmed Ticket and notify the promoted Attendee within 2 minutes.
8. WHEN a Ticket is created, THE CLOIS SHALL send a Ticket confirmation Notification to the Attendee's registered email containing the QR code image and Event details within 60 seconds.
9. WHILE an Event is in Draft, Published, or Open state, THE CLOIS SHALL allow a Member to cancel their own Ticket.
10. IF a Member attempts to cancel a Ticket after the Event has transitioned to In_Progress or Completed state, THEN THE CLOIS SHALL return an error indicating cancellation is not permitted once the Event is underway and SHALL NOT cancel the Ticket.
11. THE CLOIS SHALL support guest RSVP where a Guest provides a name (1–100 characters) and a valid email address (5–254 characters, valid format); guest Tickets SHALL be subject to the same capacity limits and QR code generation as Member Tickets.
12. WHEN a Ticket QR code is generated, THE CLOIS SHALL store the QR code image in the S3_Bucket and return a pre-signed URL valid for 7 days to the Attendee.

---

### Requirement 7: Notification and Announcement System

**User Story:** As an Organizer, I want to send targeted notifications and announcements to members and attendees, so that they stay informed throughout the event lifecycle.

#### Acceptance Criteria

1. WHEN an Organizer publishes an Announcement to all Organization Members, THE CLOIS SHALL deliver the Announcement as an in-app notification and as an email to all active Members within 5 minutes.
2. THE CLOIS SHALL support audience targeting for Announcements with the following mutually exclusive target types: All Members of the Organization, confirmed Attendees of a specific Event, Members with a specific Role, or a manually selected list of up to 500 Members.
3. WHEN a system Notification is triggered by one of the following events — RSVP confirmation, waitlist promotion, Event cancellation alert, Event reminder, or capacity-warning — THE CLOIS SHALL deliver the Notification via both email and in-app channel within 60 seconds of the triggering event.
4. WHEN the scheduled reminder time is reached for a published Event (24 hours before start and 1 hour before start), THE CLOIS SHALL send a reminder Notification to all confirmed Attendees; IF the scheduled reminder time has already passed for a given Event (e.g., Event was published with less than 24 hours to start), THE CLOIS SHALL skip that reminder without error.
5. IF a Notification delivery attempt to an email address fails after 3 retries over 15 minutes, THEN THE CLOIS SHALL mark the Notification as delivery-failed, record the failure in the Audit_Log, and SHALL NOT retry further.
6. WHEN a Member reads an in-app Notification, THE CLOIS SHALL mark it as read and SHALL update the unread count in the Member's notification badge within 5 seconds.
7. THE CLOIS SHALL retain all Notification delivery records for a minimum of 1 year for compliance and debugging purposes.
8. WHERE an Organization configures a custom email sender domain, THE CLOIS SHALL use that domain for outbound Announcements and Notifications for that Organization.
9. THE CLOIS SHALL allow a Member to opt out of email Notifications per Organization; WHEN a Member opts out, THE CLOIS SHALL suppress all future email Notifications for that Organization while continuing to deliver in-app Notifications.
10. WHEN a Notification is dispatched to a Member who has no active session, THE CLOIS SHALL persist the in-app Notification so it is visible the next time the Member opens the platform, and SHALL NOT discard it.

---

### Requirement 8: Event Check-In and Real-Time Operations

**User Story:** As an Organizer running a live event, I want to check in attendees quickly and see real-time attendance counts, so that I can manage capacity and operations on the day.

#### Acceptance Criteria

1. WHEN a Check-In operator scans a valid Ticket QR code during an In_Progress Event, THE CLOIS SHALL mark the Ticket as checked-in, record the check-in timestamp, and return a confirmation response within 2 seconds.
2. IF a Check-In operator scans a Ticket QR code for an Event that is not in In_Progress state, THEN THE CLOIS SHALL return a rejection response indicating the Event is not active and SHALL NOT mark the Ticket as checked-in.
3. IF a Check-In operator scans a Ticket that has already been checked in, THEN THE CLOIS SHALL return a duplicate-check-in warning response that includes the original check-in timestamp and SHALL NOT create a second check-in record.
4. IF a Check-In operator scans a Ticket QR code that does not correspond to a valid, non-cancelled, non-voided Ticket for the target Event, THEN THE CLOIS SHALL return an invalid-ticket rejection response.
5. WHILE an Event is In_Progress, THE Dashboard SHALL display the current check-in count, remaining capacity (Event capacity minus checked-in count), and real-time attendance percentage (checked-in count divided by Event capacity, rounded to the nearest whole number), refreshing at most every 10 seconds.
6. IF a Check-In operator is unable to scan the QR code, THEN THE CLOIS SHALL allow manual check-in by entering the exact ticket code or the exact full name of the Attendee; the same duplicate-check and validity rules SHALL apply as for QR scan check-in.
7. WHEN the total check-in count for an Event reaches 90% of the Event capacity, THE CLOIS SHALL send a capacity-warning Notification to all Organizers and Admins of the Organization.
8. WHEN the total check-in count for an Event reaches 100% of the Event capacity, THE CLOIS SHALL send a capacity-full Notification to all Organizers and Admins and SHALL display a capacity-full alert on the Dashboard that persists until dismissed by an Organizer or Admin, or until the Event exits In_Progress state.

---

### Requirement 9: Real-Time Dashboard and Monitoring

**User Story:** As an Admin or Organizer, I want a live dashboard showing event and organization health metrics, so that I can monitor operations and respond to issues quickly.

#### Acceptance Criteria

1. WHEN an authenticated Admin or Organizer opens the Dashboard for their Organization, THE CLOIS SHALL render the Dashboard with aggregate metrics no older than 60 seconds within 3 seconds of page load.
2. WHILE the Dashboard is open and scoped to an Organization, THE Dashboard SHALL display: upcoming Events count, total registered Attendees across active Events, total check-ins for In_Progress Events, and a list of Events by status; all data SHALL be scoped exclusively to that Organization.
3. WHILE an Event is In_Progress, THE Dashboard SHALL display per-Event metrics including check-in count, capacity percentage (check-ins ÷ max capacity, rounded to one decimal place), and time elapsed since Event start, updated at most every 10 seconds via server-sent events or WebSocket.
4. WHEN the Dashboard is rendered for an Organization, THE CLOIS SHALL display an Organization-level summary showing total Events run, total Attendee registrations, and average attendance rate (total check-ins ÷ total registrations), all calculated over the trailing 12 calendar months from the current date.
5. IF a data fetch for a Dashboard widget fails, THEN THE Dashboard SHALL display the last successfully fetched value alongside a staleness indicator showing the timestamp of that last successful fetch, and SHALL retry the fetch automatically every 30 seconds.
6. IF the Dashboard is opened and no prior successful data fetch exists for a widget, THEN THE Dashboard SHALL display an unavailable-state indicator for that widget and SHALL retry the fetch automatically every 30 seconds.

---

### Requirement 10: Post-Event Analytics and Reporting

**User Story:** As an Admin, I want to view detailed post-event analytics reports, so that I can understand engagement, identify trends, and improve future events.

#### Acceptance Criteria

1. WHEN an Event transitions to Completed state, THE CLOIS SHALL automatically generate an Analytics_Report containing attendance rate, check-in rate, waitlist count, cancellation count, and registration-over-time data within 10 minutes.
2. WHEN an Admin or Organizer views the Analytics_Report for an Event, THE CLOIS SHALL restrict access so that Organizers can only view reports for Events they created, while Admins can view reports for all Events within their Organization.
3. THE CLOIS SHALL support export of Analytics_Reports as CSV and PDF formats; exported files SHALL be stored in the S3_Bucket and delivered via a pre-signed download URL valid for 24 hours.
4. WHEN an Admin requests an Organization-level trend report, THE CLOIS SHALL aggregate Analytics_Reports across all Events within a user-selected date range of up to 24 months.
5. WHEN the requested trend report covers 100 or fewer Events, THE CLOIS SHALL return the report synchronously within 10 seconds.
6. WHEN an Admin requests a trend report for a date range containing more than 100 Events, THE CLOIS SHALL process the report asynchronously, notify the Admin via Notification when the report is ready, and provide a download link within 30 minutes.
7. THE CLOIS SHALL retain all Analytics_Reports for a minimum of 3 years from the date of generation.
8. IF a Member's data is subject to a deletion request under applicable privacy law, THEN THE CLOIS SHALL anonymize that Member's individual contribution to existing Analytics_Reports — replacing identifying attributes with anonymized placeholder values such that the Member cannot be re-identified — within 30 days, rather than deleting the aggregated report records.

---

### Requirement 11: Workflow Automation

**User Story:** As an Organizer, I want the platform to automate routine tasks like reminders and status transitions, so that I can focus on running the community rather than manual operational steps.

#### Acceptance Criteria

1. THE CLOIS SHALL implement all multi-step automated processes as Step_Functions_Machines to ensure reliable, auditable execution with retry semantics.
2. WHEN an Event is successfully published, THE CLOIS SHALL schedule EventBridge_Bus rules to trigger the In_Progress and Completed state transitions at the Event's configured start and end datetimes respectively within 30 seconds of publication; IF scheduling fails, THEN THE CLOIS SHALL return an error to the publishing Organizer and set the Event back to Draft state.
3. WHEN an Event's start or end datetime is updated after publishing, THE CLOIS SHALL update the corresponding EventBridge_Bus rules to reflect the new datetimes within 30 seconds.
4. WHEN an Event is cancelled or archived, THE CLOIS SHALL delete the corresponding EventBridge_Bus scheduled rules for that Event within 30 seconds to prevent stale rule triggers.
5. WHEN the scheduled reminder time is reached for a published Event, THE CLOIS SHALL dispatch reminder Notifications via a Step_Functions_Machine; IF the reminder dispatch time has already passed at the time of scheduling (e.g., Event published with less than 24 hours to start), THE CLOIS SHALL skip that reminder step without error.
6. WHEN an automated Workflow step fails, THE CLOIS SHALL retry the step with exponential backoff starting at 5 seconds with a 2× multiplier, up to 3 attempts, before marking the Workflow execution as failed and recording the failure in the Audit_Log.
7. THE CLOIS SHALL expose a Workflow execution history per Event to Admins, showing each step, its status (Succeeded, Failed, Running), and timestamps.
8. WHERE an Organization configures a post-event survey (future phase), THE CLOIS SHALL trigger a survey distribution Workflow within 1 hour of Event completion.

---

### Requirement 12: AI-Assisted Event Description Generation

**User Story:** As an Organizer, I want AI to help me write compelling event descriptions, so that I can produce polished content quickly without being a professional writer.

#### Acceptance Criteria

1. WHEN an Organizer requests AI-generated content for an Event description by providing a title, topic keywords, and target audience, THE AI_Assistant SHALL return a draft description of 100–500 words within 10 seconds.
2. THE AI_Assistant SHALL generate content using Amazon Bedrock and SHALL NOT transmit Organization Member data (names, emails, or profile details) to the Bedrock API as part of the prompt.
3. WHEN the AI_Assistant returns a draft description, THE CLOIS SHALL present it as editable text; the Organizer SHALL be able to modify or accept the draft to save it to the Event record, or discard it to dismiss the draft without making changes to the Event record.
4. IF the AI_Assistant returns an empty response, a response below 100 words, or a malformed response, THEN THE CLOIS SHALL display an error message to the Organizer indicating the generation failed and SHALL offer the option to retry or proceed manually.
5. IF the Amazon Bedrock service is unavailable, THEN THE CLOIS SHALL display an error message to the Organizer and SHALL NOT block Event creation or editing from proceeding manually.
6. THE CLOIS SHALL log each AI content generation request including the prompt parameters (excluding PII), the model used, and the response latency in the Audit_Log for cost monitoring purposes.

---

### Requirement 13: AI-Assisted Smart Scheduling Suggestions

**User Story:** As an Organizer, I want the AI to suggest optimal dates and times for new events, so that I can maximize attendance by choosing times that historically work well for my community.

#### Acceptance Criteria

1. WHEN an Organizer requests scheduling suggestions for a new Event within an Organization that has at least 5 completed Events, THE AI_Assistant SHALL analyze the historical attendance patterns of past Events and return up to 5 suggested date-time slots ranked by predicted attendance within 15 seconds.
2. WHEN generating scheduling suggestions, THE AI_Assistant SHALL include in the ranking analysis: day of week, time of day (in 1-hour increments), season, average attendance rate by slot, and scheduling conflicts with existing published Events (defined as time overlap with any published Event in the same Organization).
3. IF an Organization has fewer than 5 completed Events, THEN THE AI_Assistant SHALL return a message indicating insufficient data for personalized suggestions and SHALL offer at least 3 generic best-practice scheduling recommendations.
4. WHEN scheduling suggestions are displayed, THE CLOIS SHALL show each suggestion with a predicted attendance percentage (expressed as 0–100%) and at least 2 reasoning factors per suggestion (e.g., "Saturdays at 2 PM average 85% attendance in your Organization") so the Organizer can make an informed choice.
5. THE CLOIS SHALL display a disclaimer alongside scheduling suggestions stating that the suggestions are based on historical patterns and are not guarantees of future attendance.

---

### Requirement 14: AI-Powered Sentiment Analysis

**User Story:** As an Admin, I want AI to analyze post-event feedback and surface sentiment insights, so that I can understand community perception without manually reading every response.

#### Acceptance Criteria

1. WHEN post-event feedback text is submitted by Attendees and an Admin requests a sentiment analysis, THE AI_Assistant SHALL process the feedback corpus through Amazon Bedrock and return a Sentiment_Score and a summary of the top 3 positive themes and top 3 negative themes within 30 seconds for a corpus of up to 500 feedback entries.
2. WHEN the feedback corpus contains more than 500 entries, THE CLOIS SHALL process the 500 most recently submitted entries and indicate in the response that the analysis covers a sample of the most recent 500 entries.
3. THE AI_Assistant SHALL return a Sentiment_Score in the range [-1.0, 1.0] where -1.0 represents entirely negative sentiment, 0.0 represents neutral, and 1.0 represents entirely positive sentiment.
4. IF the feedback corpus contains fewer than 3 entries, THEN THE AI_Assistant SHALL return a message indicating insufficient data for reliable sentiment analysis and SHALL NOT return a Sentiment_Score.
5. IF the Amazon Bedrock service is unavailable or does not respond within 30 seconds, THEN THE CLOIS SHALL return an error message to the Admin indicating the analysis could not be completed and SHALL NOT return a partial Sentiment_Score.
6. THE CLOIS SHALL NOT include personally identifiable information (names, email addresses, or attendee identifiers) in the data sent to Amazon Bedrock for sentiment analysis.
7. WHEN a sentiment analysis is completed, THE CLOIS SHALL store the Sentiment_Score, top 3 positive themes, top 3 negative themes, entry count analyzed, and analysis timestamp in the Analytics_Report for the associated Event.

---

### Requirement 15: Role-Based Access Control (RBAC)

**User Story:** As a platform architect, I want granular role-based access control enforced at every API layer, so that Members can only perform actions permitted by their assigned role.

#### Acceptance Criteria

1. THE CLOIS SHALL enforce four named Roles within each Organization: Owner, Admin, Organizer, and Member, with the following permission hierarchy: Owner ⊇ Admin ⊇ Organizer ⊇ Member.
2. THE CLOIS SHALL enforce the following minimum permission boundaries:
   - Owner: all permissions including Organization deletion and ownership transfer
   - Admin: all permissions except Organization deletion and ownership transfer
   - Organizer: create, edit, and cancel Events; create, edit, and delete Venues; send Announcements to Event Attendees; view Analytics_Reports for Events they created
   - Member: RSVP to Events, cancel own Tickets, view own profile and Notifications
3. WHEN an API request is received, THE API_Gateway SHALL validate the caller's JWT; IF the JWT is missing, malformed, or expired, THE API_Gateway SHALL return HTTP 401; IF the JWT is valid but the caller's Role does not permit the requested operation, THE API_Gateway SHALL return HTTP 403; in both cases THE API_Gateway SHALL NOT forward the request to application logic.
4. IF a Member attempts a POST, PUT, PATCH, or DELETE operation on a resource belonging to an Organization of which they are not a Member, THEN THE API_Gateway SHALL return HTTP 403 and SHALL NOT expose whether the resource exists (no 404 response).
5. THE CLOIS SHALL evaluate permissions server-side on every request; client-side permission checks SHALL be treated as UI affordances only and SHALL NOT substitute for server-side enforcement.

---

### Requirement 16: Audit Logging

**User Story:** As a compliance officer, I want immutable audit logs of all security-relevant and data-mutation events, so that I can investigate incidents and demonstrate regulatory compliance.

#### Acceptance Criteria

1. THE CLOIS SHALL write an Audit_Log entry for each of the following operations: user login, user logout, failed login attempt, MFA lockout, password change, role assignment change, Member removal, Organization creation, Organization deactivation, Event state transition, Ticket creation, Ticket cancellation, bulk invitation submission, AI content generation request, and data export request.
2. WHEN an auditable operation occurs, THE CLOIS SHALL write the Audit_Log entry within 5 seconds, including: timestamp (UTC ISO 8601), actor identity (Member ID or "system"), target resource type and ID, operation type, source IP address, and outcome (success or failure).
3. THE Audit_Log SHALL be stored in a dedicated DynamoDB_Table configured with no delete or update permissions for application-layer IAM roles, ensuring append-only immutability.
4. THE CLOIS SHALL retain Audit_Log entries for a minimum of 2 years from the date of creation.
5. WHEN an Admin queries the Audit_Log for their Organization filtered by date range, actor, or operation type, THE CLOIS SHALL return paginated results with up to 100 entries per page within 5 seconds.
6. THE CLOIS SHALL NOT expose Audit_Log entries for one Organization to Admins of another Organization.

---

### Requirement 17: Data Privacy and Member Data Management

**User Story:** As a Member, I want control over my personal data, so that I can trust the platform with my information and exercise my privacy rights.

#### Acceptance Criteria

1. WHEN an authenticated Member requests an export of their personal data, THE CLOIS SHALL compile a JSON file containing the Member's profile data, Ticket history, and Notification history, store it in the S3_Bucket, and deliver a pre-signed download URL valid for 48 hours within 24 hours of the request submission.
2. IF the personal data export process fails, THEN THE CLOIS SHALL notify the Member via email that the export could not be completed and SHALL NOT deliver a partial or empty file.
3. WHEN an authenticated Member submits an account deletion request, THE CLOIS SHALL send a deletion confirmation email to the Member and then anonymize the Member's personally identifiable information (replacing name, email, and phone fields with anonymized placeholder values) across all records within 30 days, and cancel all active Tickets.
4. IF a Member's account deletion affects an Organization where the Member is the sole Owner, THEN THE CLOIS SHALL reject the deletion request, inform the Member that ownership must be transferred before deletion, and SHALL NOT proceed with deletion.
5. THE CLOIS SHALL NOT persist plaintext passwords in any DynamoDB_Table or S3_Bucket; all password management SHALL be delegated exclusively to the Cognito_Pool.
6. WHEN a client connects to the CLOIS API or frontend using plain HTTP, THE CLOIS SHALL return an HTTP 301 redirect to the HTTPS equivalent URL and SHALL NOT process the HTTP request.
7. THE CLOIS SHALL provide an Admin-accessible interface that, given a Member ID or email address, identifies all DynamoDB_Tables and S3_Bucket keys containing personal data for that Member within 1 business day of request, to support compliance audits.

---

### Requirement 18: Parser and Serializer Integrity

**User Story:** As a platform engineer, I want all data serialization and deserialization operations to be round-trip safe, so that data is never silently corrupted when passed between system components.

#### Acceptance Criteria

1. THE CLOIS SHALL serialize all internal domain events published to the EventBridge_Bus as JSON documents conforming to a versioned CloudEvents schema.
2. WHEN a Lambda function deserializes a JSON payload from the API_Gateway or SQS_Queue, THE CLOIS SHALL validate the payload against the declared JSON Schema for that message type before processing.
3. IF a Lambda function receives a JSON payload that fails schema validation, THEN THE CLOIS SHALL reject the payload with HTTP 400 (for API requests) or move it to the associated dead-letter SQS_Queue (for async messages) and SHALL NOT process the invalid payload.
4. FOR ALL domain event types, serializing a domain event object to JSON and then deserializing the JSON back to a domain event object SHALL produce an object that is semantically equivalent to the original (round-trip property).
5. THE CLOIS SHALL include JSON Schema definitions for all API request and response bodies in the OpenAPI specification maintained alongside the codebase.
6. WHEN a CSV export is generated for an Analytics_Report, THE CLOIS SHALL produce a CSV file that, when parsed by a standards-compliant CSV parser (RFC 4180), reproduces the exact same structured data that was exported (round-trip property for CSV).

---

### Requirement 19: Scalability and Performance

**User Story:** As a platform operator, I want the system to scale automatically with demand and maintain acceptable response times under peak load, so that large events and community spikes do not degrade user experience.

#### Acceptance Criteria

1. THE API_Gateway and Lambda functions SHALL scale automatically to handle a minimum of 500 concurrent requests and SHALL maintain a p95 response time of 2 seconds or less across all endpoints at that concurrency level, without manual intervention.
2. WHEN an Event with more than 1,000 registered Attendees transitions to In_Progress, THE CLOIS SHALL handle the resulting burst of check-in requests at a rate of up to 100 check-ins per second without exceeding a 2-second p95 response time; WHEN the burst rate exceeds 100 check-ins per second, THE CLOIS SHALL queue the excess requests and process them with a p95 response time of 5 seconds or less.
3. THE CLOIS SHALL use SQS_Queue-based decoupling for all notification dispatch and report generation operations to ensure that high-volume events do not cause synchronous API response times to exceed the 2-second p95 bound defined in criterion 1.
4. THE CLOIS SHALL implement DynamoDB_Table access patterns optimized for the defined access patterns in this requirements document, maintaining single-digit millisecond read latency at up to 500 concurrent users.
5. WHEN a Lambda function cold start occurs, THE CLOIS SHALL complete initialization within 3 seconds for all critical API paths (authentication, RSVP, check-in).
6. THE CLOIS SHALL use S3_Bucket pre-signed URLs for all asset transfers of 1 MB or larger (including QR code images and report exports) to avoid routing binary payloads through Lambda or API_Gateway.

---

### Requirement 20: Calendar Integration (MVP Scope — Export Only)

**User Story:** As an Attendee, I want to add an event to my personal calendar, so that I can track my upcoming commitments without switching between applications.

#### Acceptance Criteria

1. WHEN an Attendee views their confirmed Ticket, THE CLOIS SHALL provide an "Add to Calendar" option that, when activated, generates an RFC 5545-compliant iCalendar (.ics) file containing the Event title, description, DTSTART (with TZID parameter), DTEND (with TZID parameter), and venue details (physical address for in-person Events, meeting URL for virtual Events) within 5 seconds.
2. WHEN the iCalendar file is exported, THE CLOIS SHALL ensure that the DTSTART and DTEND values in the file match the Event's start and end datetimes stored in the Event record at the time of export, with the correct TZID parameter for accurate timezone representation.
3. THE CLOIS SHALL generate the iCalendar file on demand per request; any cached .ics file for a given Ticket SHALL NOT be served if it was generated more than 60 minutes ago.
4. WHEN an Organizer updates an Event's start datetime, end datetime, or Venue after one or more Attendees have previously downloaded the iCalendar file, THE CLOIS SHALL send a Notification to all affected Attendees within 60 seconds informing them that the event details have changed and they should re-download the updated calendar file.

---

### Requirement 21: Error Handling and Resilience

**User Story:** As a platform operator, I want the system to handle failures gracefully and recover automatically where possible, so that transient infrastructure issues do not result in data loss or prolonged outages.

#### Acceptance Criteria

1. WHEN a Lambda function encounters an unhandled exception, THE CLOIS SHALL log the full error details including stack trace and request context to Amazon CloudWatch Logs and SHALL return a generic HTTP 500 response that does not expose internal implementation details to the caller.
2. IF a DynamoDB_Table write operation fails due to a transient error, THEN THE CLOIS SHALL retry the operation with exponential backoff and jitter up to 3 times before propagating the failure.
3. WHEN a Step_Functions_Machine execution fails after all retries are exhausted, THE CLOIS SHALL send an alert Notification to the Organization's Admins describing the failed Workflow and the affected Event.
4. THE CLOIS SHALL implement circuit breaker semantics for outbound calls to Amazon Bedrock: if 5 consecutive calls fail within 60 seconds, THE CLOIS SHALL stop sending requests to Bedrock for 120 seconds and return a service-unavailable response to callers.
5. THE CLOIS SHALL configure a dead-letter SQS_Queue for all SQS_Queue consumers; messages that fail processing after 3 attempts SHALL be moved to the DLQ and SHALL generate a CloudWatch alarm.
6. IF the EventBridge_Bus fails to deliver a scheduled rule trigger, THEN THE CLOIS SHALL provide a manual override API endpoint accessible to Admins to manually trigger Event state transitions.

---

### Requirement 22: Frontend Accessibility and Internationalization

**User Story:** As a Member with accessibility needs, I want the CLOIS frontend to be operable using assistive technologies, so that I can use the platform regardless of my abilities.

#### Acceptance Criteria

1. THE CLOIS frontend SHALL conform to WCAG 2.1 Level AA guidelines for all pages that are part of the MVP user journeys (registration, event browsing, RSVP, ticket view, check-in operator view).
2. THE CLOIS frontend SHALL provide keyboard-navigable interfaces for all interactive elements including forms, modals, dropdowns, and tables.
3. THE CLOIS frontend SHALL provide descriptive aria-label and aria-describedby attributes for all non-text interactive elements (icon buttons, QR code images, charts).
4. THE CLOIS frontend SHALL support text scaling up to 200% without horizontal scrolling or loss of content on screens with a minimum width of 320px.
5. WHERE date and time values are displayed, THE CLOIS frontend SHALL render them in the Member's configured timezone with an ISO 8601 formatted tooltip for precision.
6. THE CLOIS frontend SHALL provide English as the default language; WHERE additional languages are configured (future phase), THE CLOIS SHALL render all UI strings in the Member's preferred language.

---

### Requirement 23: API Design and Versioning

**User Story:** As a frontend developer or third-party integrator, I want a well-documented, versioned REST API, so that I can build against stable contracts and know how to handle breaking changes.

#### Acceptance Criteria

1. THE API_Gateway SHALL expose all CLOIS endpoints under a versioned URL prefix of the form /v{major}/ (e.g., /v1/); a breaking change is defined as any of the following: removing or renaming an endpoint, removing or renaming a required request field, changing a field's data type, or changing authentication requirements.
2. WHEN a new version of the CLOIS backend is deployed, THE CLOIS SHALL verify that the OpenAPI 3.1 specification document reflects all currently deployed endpoint paths, HTTP methods, request parameters, and response schemas; IF a discrepancy is found, THE CLOIS SHALL block the deployment and alert the engineering team.
3. WHEN a deprecated API endpoint is called, THE API_Gateway SHALL return a Deprecation response header containing the sunset date in ISO 8601 (YYYY-MM-DD) format and a Link response header with rel="successor-version" pointing to the replacement endpoint documentation.
4. IF a deprecated API endpoint is called and has no designated replacement, THEN THE API_Gateway SHALL return the Deprecation header with the sunset date but SHALL omit the Link header rather than providing an invalid link.
5. THE CLOIS SHALL use the following HTTP status codes consistently across all endpoints: 200 for successful reads, 201 for successful resource creation, 204 for successful deletion with no response body, 400 for validation errors, 401 for unauthenticated requests, 403 for unauthorized requests, 404 for not-found resources, 409 for conflicts, and 500 for any unhandled server-side exception or unexpected condition.
6. THE CLOIS SHALL return all 4xx and 5xx error responses in a consistent JSON structure containing: a dot-namespaced machine-readable error code (e.g., "ticket.duplicate_registration"), a human-readable message of up to 500 characters, and a request correlation ID for support tracing.

---

## Future Phase Requirements (Out of MVP Scope)

The following capability areas are acknowledged as part of the full CLOIS product vision but are deferred to future development phases:

- **FR-F1**: Recurring event automation with templated instances and exception management
- **FR-F2**: Integrated payment processing for paid events and ticket tiers (Stripe integration)
- **FR-F3**: Two-way calendar sync with Google Calendar and Microsoft Outlook via OAuth
- **FR-F4**: Social sharing integrations (LinkedIn, Facebook, Twitter/X event publishing)
- **FR-F5**: Volunteer coordination module with shift assignment, skill matching, and volunteer reporting
- **FR-F6**: Approval workflows for event creation requiring Admin sign-off before publishing
- **FR-F7**: Post-event survey creation and distribution with AI-powered result analysis
- **FR-F8**: Multi-language UI support with Member-configured locale preferences
- **FR-F9**: White-label branding per Organization (custom domain, logo, color themes)
- **FR-F10**: Native mobile applications (iOS and Android) for check-in operators and Members
- **FR-F11**: Predictive attendance modeling using extended Bedrock training on Organization history
- **FR-F12**: Advanced AI community Q&A bot powered by Bedrock Knowledge Bases
- **FR-F13**: Webhooks and event streaming API for third-party system integrations
- **FR-F14**: Granular sub-event sessions and agenda management within a parent Event
