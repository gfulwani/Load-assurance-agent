sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "com/loadassurance/agent/model/formatter",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/UIComponent"
], function (Controller, JSONModel, Filter, FilterOperator, formatter, MessageBox, MessageToast, UIComponent) {
    "use strict";

    /**
     * Base URL for CAP service actions — relative so it works on BTP without
     * hard-coding a hostname.
     */
    var SERVICE_BASE = "/load-assurance";

    return Controller.extend("com.loadassurance.agent.controller.Detail", {

        formatter: formatter,

        /* ============================================================
         * Lifecycle
         * ============================================================ */

        onInit: function () {
            // ----------------------------------------------------------
            // 1. View model: drives all bindings in Detail.view.xml
            // ----------------------------------------------------------
            var oViewModel = new JSONModel({
                // HU fields
                huID:              "",
                delivery:          "",
                status:            "",
                severity:          "",
                expectedWeight:    null,
                actualWeight:      null,
                validationConfidence: null,
                issueDescription:  "",
                // ValidationResult fields
                labelStatus:       "",
                stackingCompliance: null,
                weightDelta:       null,
                aiInsight:         "",
                rootCause:         "",
                recommendedAction: "",
                // UI state
                busy:              false,
                chatBusy:          false,
                chatMessage:       ""
            });
            this.getView().setModel(oViewModel, "detailView");

            // ----------------------------------------------------------
            // 2. Chat model: stores message history
            // ----------------------------------------------------------
            var oChatModel = new JSONModel({
                messages: [
                    {
                        role:      "agent",
                        text:      "Hello! I'm the Load Assurance Copilot. Select a topic or type a question about this handling unit.",
                        timestamp: this._now()
                    }
                ]
            });
            this.getView().setModel(oChatModel, "chat");

            // ----------------------------------------------------------
            // 3. Route handler
            // ----------------------------------------------------------
            var oRouter = UIComponent.getRouterFor(this);
            oRouter.getRoute("detail").attachPatternMatched(this._onRouteMatched, this);
        },

        /* ============================================================
         * Route handling
         * ============================================================ */

        /**
         * Fired when the "detail" route is matched.
         * Reads the HU ID from the URL, loads HU data and the matching
         * ValidationResult, then populates the view model.
         * @private
         */
        _onRouteMatched: function (oEvent) {
            var sHuID = decodeURIComponent(oEvent.getParameter("arguments").huID);
            this._loadHUDetail(sHuID);

            // Reset chat on each navigation
            var oChatModel = this.getView().getModel("chat");
            oChatModel.setProperty("/messages", [
                {
                    role:      "agent",
                    text:      "I'm ready to help with " + sHuID + ". Ask me anything about this handling unit.",
                    timestamp: this._now()
                }
            ]);
        },

        /**
         * Loads the HU and its first ValidationResult using OData V4.
         * @param {string} sHuID  The business key (huID field, not UUID)
         * @private
         */
        _loadHUDetail: function (sHuID) {
            var oView      = this.getView();
            var oViewModel = oView.getModel("detailView");
            var oODataModel = this.getOwnerComponent().getModel();

            oViewModel.setProperty("/busy", true);
            oViewModel.setProperty("/huID", sHuID);

            // Bind HandlingUnits filtered by huID
            var oHUBinding = oODataModel.bindList("/HandlingUnits", null, null, [
                new Filter("huID", FilterOperator.EQ, sHuID)
            ], {
                $select: "ID,huID,outboundDelivery,status,severity,expectedWeight,actualWeight,validationConfidence,issueDescription",
                $expand: "validationResults"
            });

            oHUBinding.requestContexts(0, 1).then(function (aContexts) {
                if (!aContexts || aContexts.length === 0) {
                    MessageBox.error("Handling Unit '" + sHuID + "' was not found.");
                    oViewModel.setProperty("/busy", false);
                    return;
                }

                var oHU = aContexts[0].getObject();

                // Populate HU fields
                oViewModel.setProperty("/huID",              oHU.huID);
                oViewModel.setProperty("/delivery",          oHU.outboundDelivery);
                oViewModel.setProperty("/status",            oHU.status);
                oViewModel.setProperty("/severity",          oHU.severity);
                oViewModel.setProperty("/expectedWeight",    oHU.expectedWeight);
                oViewModel.setProperty("/actualWeight",      oHU.actualWeight);
                oViewModel.setProperty("/validationConfidence", oHU.validationConfidence);
                oViewModel.setProperty("/issueDescription",  oHU.issueDescription || "");

                // Store UUID for action calls
                this._sHUUUID = oHU.ID;

                // Populate ValidationResult fields (first result)
                var aVRs = oHU.validationResults || [];
                if (aVRs.length > 0) {
                    var oVR = aVRs[0];
                    oViewModel.setProperty("/labelStatus",       oVR.labelStatus   || "");
                    oViewModel.setProperty("/stackingCompliance",oVR.stackingCompliance);
                    oViewModel.setProperty("/weightDelta",       oVR.weightDelta   || null);
                    oViewModel.setProperty("/aiInsight",         oVR.aiInsight     || "");
                    oViewModel.setProperty("/rootCause",         oVR.rootCause     || "");
                    oViewModel.setProperty("/recommendedAction", oVR.recommendedAction || "");
                } else {
                    // No result yet: clear
                    oViewModel.setProperty("/labelStatus",       "");
                    oViewModel.setProperty("/stackingCompliance",null);
                    oViewModel.setProperty("/weightDelta",       null);
                    oViewModel.setProperty("/aiInsight",         "");
                    oViewModel.setProperty("/rootCause",         "");
                    oViewModel.setProperty("/recommendedAction", "");
                }

                oViewModel.setProperty("/busy", false);
            }.bind(this)).catch(function (oError) {
                oViewModel.setProperty("/busy", false);
                MessageBox.error("Failed to load HU details: " + (oError.message || oError));
            });
        },

        /* ============================================================
         * Validate HU Action
         * ============================================================ */

        /**
         * Calls the CAP `validateHU` action via fetch() (not ODataModel)
         * because CAP bound/unbound actions with custom return structures
         * are easiest to invoke via plain HTTP.
         */
        onValidate: function () {
            var oViewModel = this.getView().getModel("detailView");
            var sHuID      = oViewModel.getProperty("/huID");

            if (!sHuID) {
                MessageToast.show("No Handling Unit loaded.");
                return;
            }

            oViewModel.setProperty("/busy", true);
            MessageToast.show("Validating " + sHuID + "…");

            fetch(SERVICE_BASE + "/validateHU", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ huID: sHuID })
            })
            .then(function (oResponse) {
                if (!oResponse.ok) {
                    return oResponse.text().then(function (sText) {
                        throw new Error("HTTP " + oResponse.status + ": " + sText);
                    });
                }
                return oResponse.json();
            })
            .then(function (oData) {
                // CAP returns the result under `value` when called as an unbound action
                var oResult = oData.value || oData;

                oViewModel.setProperty("/busy", false);

                // Update AI fields in the view model from the fresh result
                if (oResult) {
                    if (oResult.status)            { oViewModel.setProperty("/status",            oResult.status); }
                    if (oResult.weightDelta != null){ oViewModel.setProperty("/weightDelta",       oResult.weightDelta); }
                    if (oResult.aiInsight)         { oViewModel.setProperty("/aiInsight",         oResult.aiInsight); }
                    if (oResult.rootCause)         { oViewModel.setProperty("/rootCause",         oResult.rootCause); }
                    if (oResult.recommendedAction) { oViewModel.setProperty("/recommendedAction", oResult.recommendedAction); }
                }

                // Build result summary for dialog
                var sMessage =
                    "Status: " + (oResult.status || "—") + "\n" +
                    "Passed: " + (oResult.passed ? "Yes" : "No") + "\n" +
                    "Weight Delta: " + (oResult.weightDelta != null ? oResult.weightDelta + " kg" : "—") + "\n\n" +
                    (oResult.message || "") +
                    (oResult.aiInsight ? "\n\nAI Insight:\n" + oResult.aiInsight : "");

                MessageBox.information(sMessage, {
                    title:        "Validation Result — " + sHuID,
                    styleClass:   "sapUiContentPadding",
                    actions:      [MessageBox.Action.OK],
                    onClose:      function () {
                        // Reload the detail to pick up any persisted changes
                        this._loadHUDetail(sHuID);
                    }.bind(this)
                });
            }.bind(this))
            .catch(function (oError) {
                oViewModel.setProperty("/busy", false);
                MessageBox.error("Validation failed: " + oError.message, {
                    title: "Error"
                });
            });
        },

        /* ============================================================
         * AI Copilot Chat
         * ============================================================ */

        /**
         * Send button / Enter key handler.
         * Posts the user message to the `chat` CAP action and appends
         * both the user message and the AI reply to the chat JSONModel.
         */
        onSendChat: function () {
            var oViewModel  = this.getView().getModel("detailView");
            var oChatModel  = this.getView().getModel("chat");
            var sMessage    = (oViewModel.getProperty("/chatMessage") || "").trim();

            if (!sMessage) { return; }

            // Append user message
            this._appendChatMessage("user", sMessage);
            oViewModel.setProperty("/chatMessage", "");
            oViewModel.setProperty("/chatBusy",    true);

            // Build context string from current view model
            var sHuContext = this._buildHuContext(oViewModel);

            fetch(SERVICE_BASE + "/chat", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ message: sMessage, huContext: sHuContext })
            })
            .then(function (oResponse) {
                if (!oResponse.ok) {
                    return oResponse.text().then(function (sText) {
                        throw new Error("HTTP " + oResponse.status + ": " + sText);
                    });
                }
                return oResponse.json();
            })
            .then(function (oData) {
                var oResult = oData.value || oData;
                var sReply  = (oResult && oResult.reply) ? oResult.reply : "I could not generate a response. Please try again.";
                var bAI     = oResult && oResult.aiPowered;

                this._appendChatMessage("agent", sReply + (bAI ? " [AI]" : ""));
                oViewModel.setProperty("/chatBusy", false);
                this._scrollChatToBottom();
            }.bind(this))
            .catch(function (oError) {
                this._appendChatMessage("agent", "Sorry, I encountered an error: " + oError.message);
                oViewModel.setProperty("/chatBusy", false);
            }.bind(this));
        },

        /**
         * Suggestion chip press handler — fills the message from the button text
         * and fires onSendChat.
         * @param {sap.ui.base.Event} oEvent
         */
        onSuggestionPress: function (oEvent) {
            var sText = oEvent.getSource().getText();
            var oViewModel = this.getView().getModel("detailView");
            oViewModel.setProperty("/chatMessage", sText);
            this.onSendChat();
        },

        /* ============================================================
         * Navigation
         * ============================================================ */

        onNavBack: function () {
            var oRouter = UIComponent.getRouterFor(this);
            oRouter.navTo("worklist", {}, true /* replace history */);
        },

        /* ============================================================
         * Private helpers
         * ============================================================ */

        /**
         * Appends a message object to the chat JSONModel.
         * @param {string} sRole   "user" | "agent"
         * @param {string} sText   Message text
         * @private
         */
        _appendChatMessage: function (sRole, sText) {
            var oChatModel = this.getView().getModel("chat");
            var aMessages  = oChatModel.getProperty("/messages") || [];
            aMessages.push({
                role:      sRole,
                text:      sText,
                timestamp: this._now()
            });
            oChatModel.setProperty("/messages", aMessages);
        },

        /**
         * Builds a compact context string describing the current HU for inclusion
         * in the chat prompt sent to the backend.
         * @param {sap.ui.model.json.JSONModel} oVM
         * @returns {string}
         * @private
         */
        _buildHuContext: function (oVM) {
            return [
                "HU=" + oVM.getProperty("/huID"),
                "Delivery=" + oVM.getProperty("/delivery"),
                "Status=" + oVM.getProperty("/status"),
                "Severity=" + oVM.getProperty("/severity"),
                "ExpectedWeight=" + oVM.getProperty("/expectedWeight"),
                "ActualWeight=" + oVM.getProperty("/actualWeight"),
                "LabelStatus=" + oVM.getProperty("/labelStatus"),
                "Stacking=" + oVM.getProperty("/stackingCompliance"),
                "RootCause=" + oVM.getProperty("/rootCause")
            ].join("; ");
        },

        /**
         * Scrolls the chat list to the bottom after new messages are appended.
         * @private
         */
        _scrollChatToBottom: function () {
            var oChatList = this.byId("chatList");
            if (oChatList) {
                var oDomRef = oChatList.getDomRef();
                if (oDomRef) {
                    oDomRef.scrollTop = oDomRef.scrollHeight;
                }
            }
        },

        /**
         * Returns the current time as a locale-formatted string.
         * @returns {string}
         * @private
         */
        _now: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }

    });
});
