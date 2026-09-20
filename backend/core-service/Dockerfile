# syntax=docker/dockerfile:1

FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /workspace

COPY gradlew ./gradlew
COPY gradle ./gradle
COPY build.gradle settings.gradle ./
RUN chmod +x ./gradlew

COPY src ./src

RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew bootJar --no-daemon && \
    artifact="$(find build/libs -maxdepth 1 -type f -name '*.jar' ! -name '*-plain.jar' -print -quit)" && \
    test -n "${artifact}" && \
    cp "${artifact}" /workspace/application.jar

FROM eclipse-temurin:21-jre-jammy AS runtime

WORKDIR /app

RUN groupadd --system govbiz && \
    useradd --system \
        --gid govbiz \
        --home-dir /nonexistent \
        --shell /usr/sbin/nologin \
        govbiz

COPY --from=builder --chown=govbiz:govbiz \
    /workspace/application.jar /app/application.jar

USER govbiz:govbiz

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/application.jar"]
