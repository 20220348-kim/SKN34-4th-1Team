package ai.govbiz.core._common.config

import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import tools.jackson.databind.cfg.CoercionAction
import tools.jackson.databind.cfg.CoercionInputShape
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.type.LogicalType

/** 공개 JSON 요청에서 값의 타입을 조용히 바꾸지 않도록 Jackson coercion을 제한합니다. */
@Configuration(proxyBeanMethods = false)
class JsonDeserializationConfig {

    @Bean
    fun strictJsonRequestTypes(): JsonMapperBuilderCustomizer =
        JsonMapperBuilderCustomizer { builder ->
            reject(
                builder,
                LogicalType.Textual,
                CoercionInputShape.Integer,
                CoercionInputShape.Float,
                CoercionInputShape.Boolean,
            )
            reject(
                builder,
                LogicalType.Integer,
                CoercionInputShape.String,
                CoercionInputShape.Float,
                CoercionInputShape.Boolean,
                CoercionInputShape.EmptyString,
            )
            reject(
                builder,
                LogicalType.Boolean,
                CoercionInputShape.String,
                CoercionInputShape.Integer,
                CoercionInputShape.Float,
                CoercionInputShape.EmptyString,
            )
            reject(
                builder,
                LogicalType.Enum,
                CoercionInputShape.Integer,
                CoercionInputShape.Float,
                CoercionInputShape.Boolean,
                CoercionInputShape.EmptyString,
            )
            reject(
                builder,
                LogicalType.DateTime,
                CoercionInputShape.Integer,
                CoercionInputShape.Float,
                CoercionInputShape.Boolean,
                CoercionInputShape.EmptyString,
            )
        }

    private fun reject(
        builder: JsonMapper.Builder,
        logicalType: LogicalType,
        vararg inputShapes: CoercionInputShape,
    ) {
        builder.withCoercionConfig(logicalType) { coercionConfig ->
            for (inputShape in inputShapes) {
                coercionConfig.setCoercion(inputShape, CoercionAction.Fail)
            }
        }
    }
}
