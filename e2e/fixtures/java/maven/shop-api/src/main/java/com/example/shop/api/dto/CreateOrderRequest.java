package com.example.shop.api.dto;

import java.util.List;

public record CreateOrderRequest(Long customerId, List<Long> productIds) {}
