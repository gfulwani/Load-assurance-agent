using load.assurance as la from '../db/schema';

service LoadAssuranceService @(path:'/load-assurance') {

    entity HandlingUnits    as projection on la.HandlingUnit;
    entity ValidationResults as projection on la.ValidationResult;
    entity AIRecommendations as projection on la.AIRecommendation;

    action validateHU(huID : String) returns {
        status              : String;
        weightDelta         : Decimal;
        passed              : Boolean;
        message             : String;
        aiInsight           : String;
        rootCause           : String;
        recommendedAction   : String;
    };
    action chat(message : String, huContext : String) returns {
        reply      : String;
        aiPowered  : Boolean;
    };
}
