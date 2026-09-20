package ai.govbiz.core._health.controller

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

@WebMvcTest(HealthController::class)
class HealthControllerTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Test
    fun returnsHealthResponse() {
        mockMvc.perform(get("/api/v1/health"))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith("application/json"))
            .andExpect(jsonPath("$.status").value("up"))
            .andExpect(jsonPath("$.service").value("govbiz-core-service"))
    }

    @Test
    fun allowsReactDevelopmentOrigin() {
        mockMvc.perform(
            get("/api/v1/health")
                .header(HttpHeaders.ORIGIN, "http://localhost:5173"),
        )
            .andExpect(status().isOk())
            .andExpect(
                header().string(
                    HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN,
                    "http://localhost:5173",
                ),
            )
    }
}
