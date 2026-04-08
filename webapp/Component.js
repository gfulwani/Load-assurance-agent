sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/Device",
    "sap/ui/model/json/JSONModel"
], function (UIComponent, Device, JSONModel) {
    "use strict";

    return UIComponent.extend("com.loadassurance.agent.Component", {

        metadata: {
            manifest: "json"
        },

        /**
         * The component is initialized by UI5 automatically during the startup
         * of the app.  This method is called by the framework during startup and
         * should NOT be called by the application.
         * @public
         */
        init: function () {
            // Call the base component's init function first
            UIComponent.prototype.init.apply(this, arguments);

            // Set device model (compact / cozy)
            var oDeviceModel = new JSONModel(Device);
            oDeviceModel.setDefaultBindingMode("OneWay");
            this.setModel(oDeviceModel, "device");

            // Initialize the router
            this.getRouter().initialize();
        },

        /**
         * This method can be called to determine whether the sapUiSizeCompact
         * or sapUiSizeCozy design mode class should be set, which influences
         * the size appearance of some controls.
         * @public
         * @return {string} css class, either 'sapUiSizeCompact' or 'sapUiSizeCozy' - or empty string
         */
        getContentDensityClass: function () {
            if (this._sContentDensityClass === undefined) {
                if (!Device.support.touch) {
                    this._sContentDensityClass = "sapUiSizeCompact";
                } else {
                    this._sContentDensityClass = "sapUiSizeCozy";
                }
            }
            return this._sContentDensityClass;
        }
    });
});
