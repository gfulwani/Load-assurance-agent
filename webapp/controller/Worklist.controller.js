sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/core/UIComponent",
    "com/loadassurance/agent/model/formatter",
    "sap/m/MessageToast"
], function (Controller, JSONModel, Filter, FilterOperator, UIComponent, formatter, MessageToast) {
    "use strict";

    var BASE = "/api";

    return Controller.extend("com.loadassurance.agent.controller.Worklist", {

        formatter: formatter,

        /* ─── Lifecycle ─────────────────────────────────────────────── */

        onInit: function () {
            var sSavedIP = localStorage.getItem("scaleIP") || "";
            var oViewModel = new JSONModel({
                warehouse:      "2001",
                delivery:       "",
                deliveries:     [],
                deliveryCount:  0,
                busy:           false,
                noDataText:     "Enter a warehouse number above and press Refresh.",
                showHistory:    false,
                chatBusy:       false,
                chatMessage:    "",
                scaleIP:        sSavedIP,
                scaleConnected: !!sSavedIP,
                scaleBusy:      false,
                // Vision state
                visionBusy:       false,
                visionDelivery:   "",
                visionFindings:   null,
                ewmSummary:       "",
                aiVerdict:        "",
                huLabelMatch:     null,
                itemCountMatch:   null,
                palletCondition:  "",
                confidence:       ""
            });
            this.getView().setModel(oViewModel, "worklistView");

            var oChatModel = new JSONModel({ messages: [{
                role:      "agent",
                text:      "Hello! I'm your Load Assurance Copilot. Scan a delivery to validate it, or ask me anything about warehouse operations.",
                timestamp: this._chatNow()
            }]});
            this.getView().setModel(oChatModel, "wlChat");

            var oRouter = UIComponent.getRouterFor(this);
            oRouter.getRoute("worklist").attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function () {
            var oViewModel = this.getView().getModel("worklistView");
            var sWarehouse = oViewModel.getProperty("/warehouse");
            if (sWarehouse) {
                this._loadDeliveries(sWarehouse);
            }
        },

        /* ─── Load deliveries ───────────────────────────────────────── */

        onLoadDeliveries: function () {
            var sWarehouse = this.getView().getModel("worklistView").getProperty("/warehouse").trim();
            if (!sWarehouse) {
                MessageToast.show("Enter a warehouse number first.");
                return;
            }
            this._loadDeliveries(sWarehouse);
        },

        _loadDeliveries: function (sWarehouse) {
            var oViewModel = this.getView().getModel("worklistView");
            oViewModel.setProperty("/busy", true);
            oViewModel.setProperty("/noDataText", "Loading deliveries…");
            oViewModel.setProperty("/showHistory", false);

            fetch(BASE + "/getDeliveries", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ warehouse: sWarehouse })
            })
            .then(function (oResp) {
                if (!oResp.ok) { throw new Error("HTTP " + oResp.status); }
                return oResp.json();
            })
            .then(function (oData) {
                var aDeliveries = (oData.value || []).map(function (d) {
                    return {
                        outboundDelivery: d.outboundDelivery,
                        huCount:          d.huCount,
                        lastStatus:       "",
                        lastScanAt:       ""
                    };
                });

                // Apply any status change made on the Scan page
                try {
                    var sLast = sessionStorage.getItem("lastScanStatus");
                    if (sLast) {
                        var oLast = JSON.parse(sLast);
                        sessionStorage.removeItem("lastScanStatus");
                        aDeliveries.forEach(function (d) {
                            if (d.outboundDelivery === oLast.delivery) {
                                d.lastStatus = oLast.status;
                                d.lastScanAt = new Date().toLocaleString();
                            }
                        });
                    }
                } catch (e) { /* ignore */ }

                oViewModel.setProperty("/deliveries",    aDeliveries);
                oViewModel.setProperty("/deliveryCount", aDeliveries.length);
                oViewModel.setProperty("/noDataText",
                    aDeliveries.length === 0
                        ? "No open outbound deliveries found in warehouse " + sWarehouse + "."
                        : "");
                oViewModel.setProperty("/busy", false);

                // Enrich with last scan status from OData history (best-effort)
                this._enrichWithHistory(aDeliveries, sWarehouse, oViewModel);
            }.bind(this))
            .catch(function (oErr) {
                oViewModel.setProperty("/busy", false);
                oViewModel.setProperty("/noDataText", "Failed to load deliveries: " + oErr.message);
            });
        },

        /**
         * For each delivery, look up the most recent ShipmentScan to show last status.
         * Done via OData binding — non-blocking, enriches the list after it renders.
         */
        _enrichWithHistory: function (aDeliveries, sWarehouse, oViewModel) {
            var oODataModel = this.getOwnerComponent().getModel();
            if (!oODataModel) { return; }
            aDeliveries.forEach(function (oDelivery, iIdx) {
                var oListBinding = oODataModel.bindList("/ShipmentScans", null, null,
                    [
                        new Filter(
                            [new Filter("outboundDelivery", FilterOperator.EQ, oDelivery.outboundDelivery),
                             new Filter("warehouse",        FilterOperator.EQ, sWarehouse),
                             new Filter("dispatchStatus",   FilterOperator.NE, "SUPERSEDED")],
                            true
                        )
                    ],
                    { $orderby: "createdAt desc" }
                );
                oListBinding.requestContexts(0, 1).then(function (aCtx) {
                    if (aCtx && aCtx.length > 0) {
                        var oScan = aCtx[0].getObject();
                        var aDelivs = oViewModel.getProperty("/deliveries");
                        aDelivs[iIdx].lastStatus = oScan.dispatchStatus || "";
                        aDelivs[iIdx].lastScanAt = oScan.createdAt
                            ? new Date(oScan.createdAt).toLocaleString()
                            : "";
                        oViewModel.setProperty("/deliveries", aDelivs);
                    }
                }).catch(function () { /* silent */ });
            });
        },

        /* ─── Search filter ─────────────────────────────────────────── */

        onFilterDeliveries: function (oEvent) {
            var sQuery = (oEvent.getParameter("newValue") || "").toLowerCase();
            var oViewModel = this.getView().getModel("worklistView");
            var aAll = oViewModel.getProperty("/deliveries") || [];
            if (!sQuery) {
                oViewModel.setProperty("/deliveries", aAll);
                return;
            }
            var aFiltered = aAll.filter(function (d) {
                return d.outboundDelivery.toLowerCase().includes(sQuery);
            });
            oViewModel.setProperty("/deliveries", aFiltered);
        },

        /* ─── Navigate to Scan ──────────────────────────────────────── */

        onScanDelivery: function () {
            var oViewModel = this.getView().getModel("worklistView");
            var sDelivery  = (oViewModel.getProperty("/delivery")  || "").trim();
            var sWarehouse = (oViewModel.getProperty("/warehouse") || "").trim();
            if (!sDelivery || !sWarehouse) {
                MessageToast.show("Enter both warehouse and delivery number.");
                return;
            }
            UIComponent.getRouterFor(this).navTo("scan", {
                delivery:  encodeURIComponent(sDelivery),
                warehouse: encodeURIComponent(sWarehouse)
            });
        },

        onDeliveryPress: function (oEvent) {
            var oViewModel  = this.getView().getModel("worklistView");
            var sWarehouse  = oViewModel.getProperty("/warehouse");
            var oSource     = oEvent.getSource();
            // Walk up to find the item with a worklistView binding context
            var oItem = oSource;
            while (oItem && !oItem.getBindingContext("worklistView")) {
                oItem = oItem.getParent();
            }
            var oCtx = oItem && oItem.getBindingContext("worklistView");
            if (!oCtx) { return; }
            var sDelivery = oCtx.getProperty("outboundDelivery");
            UIComponent.getRouterFor(this).navTo("scan", {
                delivery:  encodeURIComponent(sDelivery),
                warehouse: encodeURIComponent(sWarehouse)
            });
        },

        /* ─── Vision / Scan Pallet ──────────────────────────────────── */

        onScanPalletRow: function (oEvent) {
            var oViewModel = this.getView().getModel("worklistView");
            // Resolve which delivery row was clicked
            var oSource = oEvent.getSource();
            var oItem   = oSource;
            while (oItem && !oItem.getBindingContext("worklistView")) {
                oItem = oItem.getParent();
            }
            var oCtx = oItem && oItem.getBindingContext("worklistView");
            if (!oCtx) { return; }
            var sDelivery = oCtx.getProperty("outboundDelivery");

            // Reset vision state and store target delivery
            oViewModel.setProperty("/visionDelivery",  sDelivery);
            oViewModel.setProperty("/visionBusy",      false);
            oViewModel.setProperty("/visionFindings",  null);
            oViewModel.setProperty("/ewmSummary",      "");
            oViewModel.setProperty("/aiVerdict",       "");
            oViewModel.setProperty("/huLabelMatch",    null);
            oViewModel.setProperty("/itemCountMatch",  null);
            oViewModel.setProperty("/palletCondition", "");
            oViewModel.setProperty("/confidence",      "");

            // Open dialog first, then trigger file picker
            var oDialog = this.byId("visionDialog");
            if (oDialog) { oDialog.open(); }

            // Trigger file input
            var el = document.getElementById("wlPalletFileInput");
            if (!el) {
                el = document.createElement("input");
                el.type    = "file";
                el.accept  = "image/*";
                el.capture = "environment";
                document.body.appendChild(el);
            }
            el.value    = "";
            el.onchange = this._onWlPalletImageSelected.bind(this);
            el.click();
        },

        _onWlPalletImageSelected: function (oEvent) {
            var oFile = oEvent.target.files && oEvent.target.files[0];
            if (!oFile) { return; }

            var oViewModel = this.getView().getModel("worklistView");
            var sDelivery  = oViewModel.getProperty("/visionDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");

            oViewModel.setProperty("/visionBusy", true);

            var reader = new FileReader();
            reader.onload = function (e) {
                var sDataUrl   = e.target.result;
                var sMediaType = oFile.type || "image/jpeg";
                var sBase64    = sDataUrl.split(",")[1];

                fetch("/api/scanPallet", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({
                        outboundDelivery: sDelivery,
                        warehouse:        sWarehouse,
                        imageBase64:      sBase64,
                        imageMediaType:   sMediaType
                    })
                })
                .then(function (r) {
                    if (!r.ok) {
                        return r.json().then(function (e) {
                            throw new Error(e.error?.message || "Vision failed (HTTP " + r.status + ")");
                        });
                    }
                    return r.json();
                })
                .then(function (oData) {
                    var v = oData.value || oData;
                    var oFindings = {};
                    try { oFindings = JSON.parse(v.visionFindings || "{}"); } catch (e) {}
                    oViewModel.setProperty("/visionBusy",      false);
                    oViewModel.setProperty("/visionFindings",  oFindings);
                    oViewModel.setProperty("/ewmSummary",      v.ewmSummary      || "");
                    oViewModel.setProperty("/aiVerdict",       v.aiVerdict       || "");
                    oViewModel.setProperty("/huLabelMatch",    v.huLabelMatch    != null ? v.huLabelMatch    : null);
                    oViewModel.setProperty("/itemCountMatch",  v.itemCountMatch  != null ? v.itemCountMatch  : null);
                    oViewModel.setProperty("/palletCondition", v.palletCondition || "UNKNOWN");
                    oViewModel.setProperty("/confidence",      v.confidence      || "");
                })
                .catch(function (oErr) {
                    oViewModel.setProperty("/visionBusy", false);
                    sap.m.MessageBox.error("Vision scan failed: " + oErr.message, { title: "Vision Error" });
                });
            };
            reader.readAsDataURL(oFile);
        },

        onVisionThenScan: function () {
            // "Scan & Validate" button inside dialog — navigate to Scan page for full weight validation
            var oViewModel = this.getView().getModel("worklistView");
            var sDelivery  = oViewModel.getProperty("/visionDelivery");
            var sWarehouse = oViewModel.getProperty("/warehouse");
            var oDialog    = this.byId("visionDialog");
            if (oDialog) { oDialog.close(); }
            if (sDelivery && sWarehouse) {
                UIComponent.getRouterFor(this).navTo("scan", {
                    delivery:  encodeURIComponent(sDelivery),
                    warehouse: encodeURIComponent(sWarehouse)
                });
            }
        },

        onCloseVisionDialog: function () {
            var oDialog = this.byId("visionDialog");
            if (oDialog) { oDialog.close(); }
        },

        /* ─── Scale Connection ──────────────────────────────────────────── */

        onConnectScale: function () {
            var oViewModel = this.getView().getModel("worklistView");
            var sIP = (oViewModel.getProperty("/scaleIP") || "").trim();
            if (!sIP) {
                MessageToast.show("Enter the scale IP address or hostname.");
                return;
            }

            oViewModel.setProperty("/scaleBusy", true);
            oViewModel.setProperty("/scaleConnected", false);

            var PATHS = ["/weight", "/api/weight", "/api/v1/weight", "/data"];
            var promises = PATHS.map(function (sPath) {
                return fetch("http://" + sIP + sPath, { signal: AbortSignal.timeout(3000) })
                    .then(function (r) {
                        if (!r.ok) { return Promise.reject(); }
                        return r.json();
                    })
                    .then(function (d) {
                        var w = parseFloat(d.weight ?? d.value ?? d.Weight ?? d.Value);
                        if (isNaN(w)) { return Promise.reject(); }
                        return { weight: w, unit: (d.unit || d.Unit || "KG").toUpperCase() };
                    });
            });

            Promise.any(promises)
                .then(function (oResult) {
                    oViewModel.setProperty("/scaleBusy", false);
                    oViewModel.setProperty("/scaleConnected", true);
                    localStorage.setItem("scaleIP", sIP);
                    MessageToast.show("Scale connected: " + oResult.weight.toFixed(3) + " " + oResult.unit);
                })
                .catch(function () {
                    oViewModel.setProperty("/scaleBusy", false);
                    oViewModel.setProperty("/scaleConnected", false);
                    MessageToast.show("Could not reach scale at " + sIP + ". Check IP and network.");
                });
        },

        /* ─── AI Copilot Dialog ─────────────────────────────────────── */

        onOpenCopilot: function () {
            var oDialog = this.byId("copilotDialog");
            if (oDialog) { oDialog.open(); }
        },

        onCloseCopilot: function () {
            var oDialog = this.byId("copilotDialog");
            if (oDialog) { oDialog.close(); }
        },

        /* ─── History ───────────────────────────────────────────────── */

        onShowHistory: function () {
            this.getView().getModel("worklistView").setProperty("/showHistory", true);
        },

        onHideHistory: function () {
            this.getView().getModel("worklistView").setProperty("/showHistory", false);
        },

        onHistoryItemPress: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext();
            if (!oCtx) { return; }
            var oScan = oCtx.getObject();
            UIComponent.getRouterFor(this).navTo("scan", {
                delivery:  encodeURIComponent(oScan.outboundDelivery),
                warehouse: encodeURIComponent(oScan.warehouse)
            });
        },

        /* ─── AI Copilot Chat ───────────────────────────────────────── */

        onWlSendChat: function () {
            var oViewModel = this.getView().getModel("worklistView");
            var sMsg = (oViewModel.getProperty("/chatMessage") || "").trim();
            if (!sMsg) { return; }

            this._wlAppendChat("user", sMsg);
            oViewModel.setProperty("/chatMessage", "");
            oViewModel.setProperty("/chatBusy", true);

            var sWarehouse = oViewModel.getProperty("/warehouse");
            var nCount     = oViewModel.getProperty("/deliveryCount");
            var sContext   = "Warehouse=" + sWarehouse +
                "; OpenDeliveries=" + nCount +
                "; Page=Worklist";

            var that = this;
            fetch(BASE + "/chat", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ message: sMsg, context: sContext })
            })
            .then(function (r) { return r.json(); })
            .then(function (oData) {
                var v = oData.value || oData;
                that._wlAppendChat("agent", v.reply || "AI temporarily unavailable.");
                oViewModel.setProperty("/chatBusy", false);
            })
            .catch(function (oErr) {
                that._wlAppendChat("agent", "Error: " + oErr.message);
                oViewModel.setProperty("/chatBusy", false);
            });
        },

        onWlChatSuggestion: function (oEvent) {
            var sText = oEvent.getSource().getText();
            this.getView().getModel("worklistView").setProperty("/chatMessage", sText);
            this.onWlSendChat();
        },

        _wlAppendChat: function (sRole, sText) {
            var oChatModel = this.getView().getModel("wlChat");
            var aMessages  = oChatModel.getProperty("/messages") || [];
            aMessages.push({ role: sRole, text: sText, timestamp: this._chatNow() });
            oChatModel.setProperty("/messages", aMessages);
        },

        _chatNow: function () {
            return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }

    });
});
